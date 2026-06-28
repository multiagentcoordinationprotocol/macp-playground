#!/usr/bin/env python3
"""CrewAI compliance agent — evaluates proposals using a real CrewAI crew.

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

from crew import build_crew
from mappers import map_kickoff_to_crew_inputs

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
    except Exception as err:  # noqa: BLE001
        logger.warning("%s emit failed: %s", message_type, err)


def emit_progress(actions, progress: float, message: str = "") -> None:
    payload = core_pb2.ProgressPayload(
        progress=max(0.0, min(1.0, float(progress))),
        message=str(message),
    )
    _safe_emit(actions, "Progress", payload)


def emit_signal(actions, signal_type: str, data: dict | None = None, confidence: float = 1.0) -> None:
    """Emit an ambient Signal (empty envelope.session_id/mode per RFC-MACP-0001)."""
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


def main() -> int:
    participant = from_bootstrap()
    session_context = _load_session_context()

    def handle_proposal(message, ctx):
        emit_signal(
            ctx.actions,
            "session.started",
            {"role": "compliance-reviewer", "framework": "crewai", "agentRef": "compliance-agent"},
        )
        emit_progress(ctx.actions, 0.10, "received proposal")

        emit_progress(ctx.actions, 0.30, "running compliance crew")
        crew_inputs = map_kickoff_to_crew_inputs(session_context)
        crew = build_crew(crew_inputs)
        t0 = time.time()
        crew_result = crew.kickoff()
        latency_ms = int((time.time() - t0) * 1000)

        raw_text = ""
        if hasattr(crew_result, "raw"):
            raw_text = str(crew_result.raw)
        elif isinstance(crew_result, str):
            raw_text = crew_result
        elif isinstance(crew_result, dict):
            raw_text = json.dumps(crew_result)
        else:
            raw_text = str(crew_result)

        crew_output: dict = {}
        try:
            crew_output = json.loads(raw_text)
            if not isinstance(crew_output, dict):
                crew_output = {}
        except (ValueError, TypeError):
            crew_output = {}

        message_type = str(crew_output.get("message_type", "Evaluation"))
        recommendation = str(crew_output.get("recommendation", "REVIEW")).upper()
        confidence = float(crew_output.get("confidence", 0.76))
        reason = str(crew_output.get("reason", raw_text or "compliance crew evaluation"))[:500]
        severity = str(crew_output.get("severity", "high"))
        proposal_id = message.proposal_id or ""

        # CrewAI's Crew object exposes usage_metrics after kickoff() in recent versions.
        usage = getattr(crew_result, "token_usage", None) or getattr(crew_result, "usage_metrics", None)
        if usage:
            try:
                prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
                completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
            except Exception:  # noqa: BLE001
                prompt_tokens = 0
                completion_tokens = 0
        else:
            prompt_tokens = 0
            completion_tokens = 0
        model = "gpt-4o-mini"

        logger.info(
            "crew execution complete messageType=%s recommendation=%s confidence=%s tokens=%d/%d latency=%dms",
            message_type,
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
                "participantId": "compliance-agent",
                "summary": f"recommendation={recommendation} confidence={confidence:.2f} severity={severity}",
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
        eval_recommendation = "BLOCK" if message_type == "Objection" else _eval_recommendation(recommendation)
        eval_confidence = max(0.0, min(1.0, confidence))
        try:
            ctx.actions.evaluate(proposal_id, eval_recommendation, confidence=eval_confidence, reason=reason)
            logger.info("evaluation sent proposalId=%s recommendation=%s confidence=%.2f", proposal_id, eval_recommendation, eval_confidence)
        except MacpAckError as err:
            logger.info("compliance evaluation skipped proposalId=%s err=%s", proposal_id, err)

        if message_type == "Objection":
            vote = "REJECT"
        else:
            vote = "APPROVE" if recommendation in ("APPROVE", "ALLOW", "REVIEW") else "REJECT"

        emit_progress(ctx.actions, 0.75, f"voting {vote}")

        try:
            ctx.actions.vote(proposal_id, vote, reason=reason)
            logger.info("compliance response sent proposalId=%s vote=%s recommendation=%s", proposal_id, vote, recommendation)
        except MacpAckError as err:
            if _is_session_closed(err):
                logger.info("compliance vote skipped — session already closed proposalId=%s err=%s", proposal_id, err)
            else:
                raise

        emit_progress(ctx.actions, 1.0, "complete")
        emit_signal(
            ctx.actions,
            "session.ended",
            {"vote": vote, "recommendation": recommendation, "participantId": "compliance-agent"},
        )

        participant.stop()

    participant.on("Proposal", handle_proposal)
    participant.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
