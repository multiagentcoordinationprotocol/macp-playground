"""Input/output mappers between MACP kickoff and LangChain chain I/O."""

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


def _maybe_float(value: Any):
    return None if value is None else float(value)


def _maybe_int(value: Any):
    return None if value is None else int(value)


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def score_fraud(transaction_amount, is_vip_customer, account_age_days):
    """Deterministic fraud/growth scoring — extracted from chain.py's duplicate
    inline copies (`_deterministic_growth` / `FallbackChain.invoke`) so both
    the framework-available and framework-unavailable call sites delegate to
    one implementation. Thresholds/confidence values are unchanged from the
    original inline logic — a must-not-regress constraint verified by Phase
    1's characterization tests (plans/example-agent-domain-scoring.md)."""
    amount = float(transaction_amount) if transaction_amount is not None else 0.0
    vip = bool(is_vip_customer)
    age = int(account_age_days) if account_age_days is not None else 0

    if vip and age >= 7 and amount <= 5000:
        return 'APPROVE', 0.88, 'customer value is high and the purchase fits a trusted profile'
    if amount > 5000 or age < 3:
        return 'REVIEW', 0.73, 'experience goals favor a step-up rather than an outright block'
    return 'APPROVE', 0.78, 'growth impact is favorable with manageable customer friction'


def score_lending(credit_score, debt_to_income_ratio, employment_years, prior_defaults):
    """Deterministic lending scoring. See plans/example-agent-domain-scoring.md
    Phase 2 for the formula's derivation and fixture verification."""
    if None in (credit_score, debt_to_income_ratio, employment_years, prior_defaults):
        return 'REVIEW', 0.5, 'insufficient data'

    if prior_defaults > 0:
        return 'REJECT', 0.75, f'{prior_defaults} prior default(s) on record'

    credit_component = _clamp((credit_score - 580) / (750 - 580), 0.0, 1.0)
    dti_component = _clamp((0.43 - debt_to_income_ratio) / (0.43 - 0.20), 0.0, 1.0)
    tenure_component = _clamp(employment_years / 5, 0.0, 1.0)
    composite = 0.5 * credit_component + 0.35 * dti_component + 0.15 * tenure_component

    if composite >= 0.70:
        confidence = 0.6 + 0.3 * min((composite - 0.70) / 0.30, 1.0)
        return 'APPROVE', confidence, f'composite score {composite:.2f} exceeds approval threshold'
    if composite <= 0.35:
        confidence = 0.6 + 0.3 * min((0.35 - composite) / 0.35, 1.0)
        return 'REJECT', confidence, f'composite score {composite:.2f} below rejection threshold'
    return 'REVIEW', 0.5, f'composite score {composite:.2f} requires manual review'


_CLAIMS_SEVERITY_SCORES = {'minor': 1.0, 'moderate': 0.7, 'severe': 0.35, 'total_loss': 0.15}


def score_claims(claim_amount, policy_age, prior_claims, is_high_value_policy, incident_severity):
    """Deterministic claims scoring. See plans/example-agent-domain-scoring.md
    Phase 2 for the formula's derivation and fixture verification. Never
    returns 'BLOCK' — crewai's Objection path is reserved for fraud."""
    if None in (claim_amount, policy_age, prior_claims, is_high_value_policy, incident_severity):
        return 'REVIEW', 0.5, 'insufficient data'

    severity_score = _CLAIMS_SEVERITY_SCORES.get(str(incident_severity).lower())
    if severity_score is None:
        return 'REVIEW', 0.5, 'insufficient data'

    tenure_component = _clamp(policy_age / 24, 0.0, 1.0)
    history_component = _clamp(1 - prior_claims * 0.3, 0.0, 1.0)
    value_penalty = 0.15 if is_high_value_policy else 0.0
    composite = 0.5 * severity_score + 0.25 * tenure_component + 0.25 * history_component - value_penalty

    if composite >= 0.65:
        confidence = 0.6 + 0.3 * min((composite - 0.65) / 0.35, 1.0)
        return 'APPROVE', confidence, f'composite score {composite:.2f} exceeds approval threshold'
    if composite <= 0.30:
        confidence = 0.6 + 0.3 * min((0.30 - composite) / 0.30, 1.0)
        return 'REJECT', confidence, f'composite score {composite:.2f} below rejection threshold'
    return 'REVIEW', 0.5, f'composite score {composite:.2f} requires manual review'


def score_by_domain(domain: Domain, fields: JsonDict):
    """Dispatch to the domain-appropriate deterministic scorer. `fields` is the
    already-snake_case dict produced by this module's map_kickoff_to_* function."""
    if domain == 'lending':
        return score_lending(
            fields.get('credit_score'),
            fields.get('debt_to_income_ratio'),
            fields.get('employment_years'),
            fields.get('prior_defaults'),
        )
    if domain == 'claims':
        return score_claims(
            fields.get('claim_amount'),
            fields.get('policy_age'),
            fields.get('prior_claims'),
            fields.get('is_high_value_policy'),
            fields.get('incident_severity'),
        )
    return score_fraud(
        fields.get('transaction_amount'),
        fields.get('is_vip_customer'),
        fields.get('account_age_days'),
    )


def build_prompt(domain: Domain, fields: JsonDict):
    """Domain-framed LLM prompt text as (system_message, human_message), both
    fully rendered with no unresolved template variables — extracted from
    chain.py so their content is checkable in CI (the LLM call itself stays
    untestable here, but what we send it is not; see
    plans/example-agent-domain-scoring.md Phase 3). The fraud branch is
    byte-for-byte unchanged from chain.py's original inline text. Double
    braces in the JSON-shape examples are intentional — they still pass
    through ChatPromptTemplate, which un-escapes `{{`/`}}` to literal `{`/`}`."""
    if domain == 'lending':
        system = (
            'You are a credit underwriting analyst evaluating whether a loan application should be '
            'approved, reviewed, or rejected from a creditworthiness perspective. '
            'Balance repayment risk against applicant opportunity. '
            'Respond with ONLY a JSON object (no markdown): '
            '{{"recommendation": "APPROVE"|"REVIEW"|"REJECT", "confidence": 0.0-1.0, '
            '"reason": "brief explanation", "factors": ["factor1", "factor2"]}}'
        )
        human = (
            f"Credit score: {fields.get('credit_score', 'unknown')}\n"
            f"Debt-to-income ratio: {fields.get('debt_to_income_ratio', 'unknown')}\n"
            f"Employment history: {fields.get('employment_years', 'unknown')} years\n"
            f"Prior defaults: {fields.get('prior_defaults', 0)}"
        )
        return system, human
    if domain == 'claims':
        system = (
            'You are an insurance claims analyst evaluating whether a claim should be '
            'approved, reviewed, or rejected from a policy-compliance perspective. '
            'Balance claim legitimacy against customer experience and retention. '
            'Respond with ONLY a JSON object (no markdown): '
            '{{"recommendation": "APPROVE"|"REVIEW"|"REJECT", "confidence": 0.0-1.0, '
            '"reason": "brief explanation", "factors": ["factor1", "factor2"]}}'
        )
        human = (
            f"Claim amount: ${fields.get('claim_amount', 'unknown')}\n"
            f"Policy age: {fields.get('policy_age', 'unknown')} months\n"
            f"Prior claims: {fields.get('prior_claims', 0)}\n"
            f"High-value policy: {fields.get('is_high_value_policy', False)}\n"
            f"Incident severity: {fields.get('incident_severity', 'unknown')}"
        )
        return system, human
    system = (
        'You are a growth analyst evaluating whether a transaction should be approved, '
        'reviewed, or blocked from a customer value and revenue perspective. '
        'Balance fraud risk against customer experience and retention. '
        'Respond with ONLY a JSON object (no markdown): '
        '{{"recommendation": "APPROVE"|"REVIEW"|"BLOCK", "confidence": 0.0-1.0, '
        '"reason": "brief explanation", "factors": ["factor1", "factor2"]}}'
    )
    human = (
        f"Transaction: ${fields.get('transaction_amount', 0)}\n"
        f"VIP customer: {fields.get('is_vip_customer', False)}\n"
        f"Account age: {fields.get('account_age_days', 0)} days\n"
        f"Device trust: {fields.get('device_trust_score', 0)}\n"
        f"Prior chargebacks: {fields.get('prior_chargebacks', 0)}"
    )
    return system, human


def map_kickoff_to_inputs(session_context: JsonDict, metadata: JsonDict = None) -> JsonDict:
    """Convert MACP session context into LangChain chain input."""
    return {
        'domain': detect_domain(metadata or {}),
        'transaction_amount': float(session_context.get('transactionAmount', 0.0) or 0.0),
        'is_vip_customer': bool(session_context.get('isVipCustomer', False)),
        'account_age_days': int(session_context.get('accountAgeDays', 0) or 0),
        'device_trust_score': float(session_context.get('deviceTrustScore', 0.0) or 0.0),
        'prior_chargebacks': int(session_context.get('priorChargebacks', 0) or 0),
        'credit_score': _maybe_float(session_context.get('creditScore')),
        'debt_to_income_ratio': _maybe_float(session_context.get('debtToIncomeRatio')),
        'employment_years': _maybe_float(session_context.get('employmentYears')),
        'prior_defaults': _maybe_int(session_context.get('priorDefaults')),
        'claim_amount': _maybe_float(session_context.get('claimAmount')),
        'policy_age': _maybe_float(session_context.get('policyAge')),
        'prior_claims': _maybe_int(session_context.get('priorClaims')),
        'is_high_value_policy': session_context.get('isHighValuePolicy'),
        'incident_severity': session_context.get('incidentSeverity'),
    }


def map_result_to_macp_messages(
    chain_output: JsonDict,
    proposal_id: str,
    participant_id: str,
    recipients: List[str],
    framework: str,
    agent_ref: str,
) -> List[JsonDict]:
    """Convert LangChain chain output into MACP Evaluation messages."""
    recommendation = str(chain_output.get('recommendation', 'REVIEW'))
    confidence = float(chain_output.get('confidence', 0.5))
    reason = str(chain_output.get('reason', ''))

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
                'hostKind': 'langchain-process',
                'factors': chain_output.get('factors', []),
            },
        }
    ]
