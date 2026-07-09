#!/usr/bin/env python3
"""LangGraph fraud agent — evaluates proposals using a real LangGraph graph.

Uses macp_sdk.agent.Participant to read events from the runtime's gRPC
stream and emit responses directly. No control-plane polling.
"""

import json
import os
import time
import logging

from macp_sdk.agent import from_bootstrap
from macp_sdk.envelope import build_envelope, serialize_message
from macp_sdk.errors import MacpAckError
from macp.v1 import core_pb2

from graph import build_graph
from mappers import map_kickoff_to_state

logger = logging.getLogger("macp.agent")

_TERMINAL_ACK_CODES = ("SESSION_NOT_OPEN", "UNKNOWN_SESSION", "TTL_EXPIRED")


def _is_session_closed(err: MacpAckError) -> bool:
    msg = str(err).upper()
    return any(code in msg for code in _TERMINAL_ACK_CODES)


def _eval_recommendation(recommendation: str) -> str:
    """Map an agent's free-form recommendation onto the runtime's accepted
    Evaluation enum (RFC-MACP-0004: APPROVE | REVIEW | BLOCK | REJECT).
    Preserves the approve/reject signal so the evaluation can satisfy
    confidence-gated policies; unknown/uncertain values fall back to the
    informational REVIEW (which the runtime treats as non-qualifying)."""
    rec = (recommendation or "").upper()
    if rec in ("APPROVE", "ALLOW", "ACCEPT", "PASS"):
        return "APPROVE"
    if rec in ("REJECT", "DENY", "DECLINE", "FAIL"):
        return "REJECT"
    if rec in ("BLOCK", "VETO"):
        return "BLOCK"
    return "REVIEW"


def _safe_emit(actions, message_type: str, payload):
    """Send Signal/Progress envelope; swallow session-closed races silently."""
    try:
        env = build_envelope(
            mode=getattr(actions, "_mode", "") or "",
            message_type=message_type,
            session_id=getattr(actions, "_session_id", "") or "",
            sender=getattr(actions, "_participant_id", "") or "",
            payload=serialize_message(payload),
        )
        actions.send_envelope(env)
    except MacpAckError as err:
        if _is_session_closed(err):
            return
        logger.warning("%s emit failed: %s", message_type, err)
    except Exception as err:  # noqa: BLE001 - never crash the worker over telemetry
        logger.warning("%s emit failed: %s", message_type, err)


def emit_progress(actions, progress: float, message: str = "") -> None:
    payload = core_pb2.ProgressPayload(
        progress=max(0.0, min(1.0, float(progress))),
        message=str(message),
    )
    _safe_emit(actions, "Progress", payload)


def emit_signal(actions, signal_type: str, data: dict | None = None, confidence: float = 1.0) -> None:
    """Emit an ambient Signal envelope.

    Per RFC-MACP-0001, Signal envelopes must have empty session_id and empty mode
    at the envelope level — correlation back to a session is via the payload's
    `correlation_session_id` field. The runtime rejects Signal envelopes that
    include session_id/mode at the envelope layer.
    """
    data_bytes = json.dumps(data).encode("utf-8") if data else b""
    payload = core_pb2.SignalPayload(
        signal_type=str(signal_type),
        data=data_bytes,
        confidence=float(confidence),
        correlation_session_id=getattr(actions, "_session_id", "") or "",
    )
    try:
        env = build_envelope(
            mode="",
            message_type="Signal",
            session_id="",
            sender=getattr(actions, "_participant_id", "") or "",
            payload=serialize_message(payload),
        )
        actions.send_envelope(env)
    except MacpAckError as err:
        if _is_session_closed(err):
            return
        logger.warning("Signal emit failed: %s", err)
    except Exception as err:  # noqa: BLE001
        logger.warning("Signal emit failed: %s", err)


def _load_session_context() -> dict:
    path = os.environ.get("MACP_BOOTSTRAP_FILE", "")
    if not path:
        return {}
    with open(path) as f:
        data = json.load(f)
    return (data.get("metadata") or {}).get("session_context") or {}


def _load_participants() -> tuple[list[str], str]:
    """Return (participants, own_participant_id) from the bootstrap file."""
    path = os.environ.get("MACP_BOOTSTRAP_FILE", "")
    if not path:
        return [], ""
    with open(path) as f:
        data = json.load(f)
    parts = [str(p) for p in (data.get("participants") or [])]
    return parts, str(data.get("participant_id") or "")


def main() -> int:
    participant = from_bootstrap()
    graph = build_graph()
    session_context = _load_session_context()
    participants, self_id = _load_participants()

    # Two-phase deliberation barrier (RFC-MACP-0007): emit our Evaluation on the
    # Proposal, then defer our Vote until every peer specialist has evaluated, so
    # all Evaluations land before the first Vote advances the runtime to the
    # Voting phase (after which late Evaluations are rejected as InvalidPayload).
    # Peers = declared participants minus self and the coordinator (the Proposal
    # sender, who does not emit an Evaluation).
    state: dict = {"pending": None, "peers": set(), "seen": set(), "voted": False}

    def _maybe_vote(ctx) -> None:
        pending = state["pending"]
        if state["voted"] or pending is None:
            return
        if not state["peers"].issubset(state["seen"]):
            return  # still waiting for peer evaluations
        state["voted"] = True
        vote = pending["vote"]
        emit_progress(ctx.actions, 0.75, f"voting {vote}")
        try:
            ctx.actions.vote(pending["proposal_id"], vote, reason=pending["reason"])
            logger.info(
                "vote sent proposalId=%s vote=%s recommendation=%s",
                pending["proposal_id"], vote, pending["recommendation"],
            )
        except MacpAckError as err:
            if _is_session_closed(err):
                logger.info(
                    "fraud vote skipped — session already closed proposalId=%s err=%s",
                    pending["proposal_id"], err,
                )
            else:
                raise
        emit_progress(ctx.actions, 1.0, "complete")
        emit_signal(
            ctx.actions,
            "session.ended",
            {"vote": vote, "recommendation": pending["recommendation"], "participantId": "fraud-agent"},
        )
        participant.stop()

    def handle_proposal(message, ctx):
        emit_signal(
            ctx.actions,
            "session.started",
            {"role": "claims-validator", "framework": "langgraph", "agentRef": "fraud-agent"},
        )
        emit_progress(ctx.actions, 0.10, "received proposal")

        emit_progress(ctx.actions, 0.30, "running fraud analysis graph")
        graph_input = map_kickoff_to_state(session_context)
        t0 = time.time()
        graph_output = graph.invoke(graph_input)
        latency_ms = int((time.time() - t0) * 1000)

        recommendation = str(graph_output.get("recommendation", "REVIEW")).upper()
        confidence = float(graph_output.get("confidence", 0.5))
        reason = str(graph_output.get("reason", "fraud graph evaluation"))[:500]
        proposal_id = message.proposal_id or ""
        token_usage = graph_output.get("token_usage") or {}

        prompt_tokens = int(token_usage.get("promptTokens") or token_usage.get("prompt_tokens") or 0)
        completion_tokens = int(token_usage.get("completionTokens") or token_usage.get("completion_tokens") or 0)
        model = str(token_usage.get("model") or "gpt-4o-mini")

        logger.info(
            "graph execution complete recommendation=%s confidence=%s tokens=%d/%d latency=%dms",
            recommendation,
            confidence,
            prompt_tokens,
            completion_tokens,
            latency_ms,
        )

        emit_signal(
            ctx.actions,
            "llm.call.completed",
            {
                "model": model,
                "provider": "openai",
                "promptTokens": prompt_tokens,
                "completionTokens": completion_tokens,
                "totalTokens": prompt_tokens + completion_tokens,
                "latencyMs": latency_ms,
                "tokenUsage": {
                    "promptTokens": prompt_tokens,
                    "completionTokens": completion_tokens,
                    "model": model,
                },
                "participantId": "fraud-agent",
                "summary": f"recommendation={recommendation} confidence={confidence:.2f}",
            },
        )

        # Emit an Evaluation before voting. Decision policies may require
        # qualifying evaluations before a commitment is allowed (RFC-MACP-0007;
        # e.g. lending.conservative minimum_confidence=0.6, fraud.unanimous=0.7).
        # The runtime keys that check on Evaluation messages, not Votes/Signals,
        # so without this the commit is denied ("no qualifying evaluation meets
        # minimum confidence threshold") even on unanimous approval and the run
        # is cancelled. We already have the recommendation + confidence here.
        # Normalize to the runtime's accepted enum (RFC-MACP-0004: APPROVE |
        # REVIEW | BLOCK | REJECT) and clamp confidence to [0,1] so the envelope
        # is valid. Best-effort: a rejected/closed evaluation must never crash
        # the agent before it votes.
        eval_recommendation = _eval_recommendation(recommendation)
        eval_confidence = max(0.0, min(1.0, confidence))
        try:
            ctx.actions.evaluate(proposal_id, eval_recommendation, confidence=eval_confidence, reason=reason)
            logger.info(
                "evaluation sent proposalId=%s recommendation=%s confidence=%.2f",
                proposal_id, eval_recommendation, eval_confidence,
            )
        except MacpAckError as err:
            logger.info("fraud evaluation skipped proposalId=%s err=%s", proposal_id, err)

        # Stage the vote; the barrier releases it once peers have evaluated.
        vote = "APPROVE" if recommendation in ("APPROVE", "ALLOW", "REVIEW") else "REJECT"
        coordinator = message.sender or ""
        state["peers"] = {p for p in participants if p not in (self_id, coordinator)}
        state["pending"] = {
            "proposal_id": proposal_id,
            "vote": vote,
            "reason": reason,
            "recommendation": recommendation,
        }
        _maybe_vote(ctx)  # vote immediately if peers already evaluated (or none)

    def handle_evaluation(message, ctx):
        # Barrier: record each peer's evaluation; vote once all peers are in.
        if message.sender and message.sender != self_id:
            state["seen"].add(message.sender)
        _maybe_vote(ctx)

    participant.on("Proposal", handle_proposal)
    participant.on("Evaluation", handle_evaluation)
    participant.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
