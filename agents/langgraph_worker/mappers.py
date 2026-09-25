"""Input/output mappers between MACP kickoff and LangGraph state."""

import logging
from typing import Any, Dict, List, Literal

JsonDict = Dict[str, Any]
logger = logging.getLogger("macp.agent")

Domain = Literal['fraud', 'lending', 'claims']
_DOMAIN_PREFIXES = {'fraud': 'fraud', 'lending': 'lending', 'claims': 'claims'}


def detect_domain(metadata: JsonDict) -> Domain:
    """Resolve which pack domain a run belongs to, from its scenario_ref.

    Defaults to 'fraud' — this worker's original, only-ever-tested domain —
    for any missing or unrecognized scenario_ref, logging a warning so a
    misconfigured bootstrap is visible rather than silently misdiagnosed as
    "the LLM hedged".
    """
    scenario_ref = str((metadata or {}).get('scenario_ref') or '')
    prefix = scenario_ref.split('/', 1)[0] if '/' in scenario_ref else ''
    domain = _DOMAIN_PREFIXES.get(prefix)
    if domain is None:
        logger.warning('unrecognized or missing scenario_ref %r; defaulting to fraud domain', scenario_ref)
        return 'fraud'
    return domain


def extract_agent_metadata(metadata: JsonDict) -> JsonDict:
    """Pull the scenario_ref/role pair a worker's session.started signal needs."""
    return {
        'scenario_ref': str((metadata or {}).get('scenario_ref') or ''),
        'role': str((metadata or {}).get('role') or ''),
    }


def map_kickoff_to_state(session_context: JsonDict) -> JsonDict:
    """Convert MACP session context into LangGraph input state."""
    return {
        'device_trust_score': float(session_context.get('deviceTrustScore', 0.0) or 0.0),
        'prior_chargebacks': int(session_context.get('priorChargebacks', 0) or 0),
        'transaction_amount': float(session_context.get('transactionAmount', 0.0) or 0.0),
        'account_age_days': int(session_context.get('accountAgeDays', 0) or 0),
        'is_vip_customer': bool(session_context.get('isVipCustomer', False)),
        'recommendation': '',
        'confidence': 0.0,
        'reason': '',
        'signals': [],
    }


def map_state_to_macp_messages(
    graph_output: JsonDict,
    proposal_id: str,
    participant_id: str,
    recipients: List[str],
    framework: str,
    agent_ref: str,
) -> List[JsonDict]:
    """Convert LangGraph terminal state into MACP Evaluation messages."""
    recommendation = str(graph_output.get('recommendation', 'REVIEW'))
    confidence = float(graph_output.get('confidence', 0.5))
    reason = str(graph_output.get('reason', ''))

    return [
        {
            'from': participant_id,
            'to': recipients,
            'messageType': 'Evaluation',
            'payloadEnvelope': {
                'encoding': 'proto',
                'proto': {
                    'typeName': 'macp.modes.decision.v1.EvaluationPayload',
                    'value': {
                        'proposal_id': proposal_id,
                        'recommendation': recommendation,
                        'confidence': confidence,
                        'reason': reason,
                    },
                },
            },
            'metadata': {
                'framework': framework,
                'agentRef': agent_ref,
                'hostKind': 'langgraph-process',
                'signals': graph_output.get('signals', []),
            },
        }
    ]
