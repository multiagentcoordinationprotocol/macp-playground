"""CrewAI compliance review crew.

When crewai and langchain-openai are installed and OPENAI_API_KEY is set,
this builds a real Crew with an LLM-powered Agent. Otherwise, falls back
to deterministic logic.
"""

import os
from typing import Any, Dict

try:
    from mappers import score_by_domain
except ImportError:
    from .mappers import score_by_domain

JsonDict = Dict[str, Any]


def _score_result(inputs: JsonDict) -> JsonDict:
    """Delegate to mappers.score_by_domain and translate its 3-tuple into the
    dict shape main.py expects. 'BLOCK' is the only recommendation that ever
    triggers an Objection (crewai's separate veto-style message) instead of a
    plain Evaluation — matching today's fraud-only behavior exactly; lending
    and claims never return 'BLOCK' so they always route to Evaluation.
    Confidence is intentionally omitted for the Objection case, matching the
    original dict's shape (plans/example-agent-domain-scoring.md Phase 2)."""
    domain = inputs.get('domain', 'fraud')
    recommendation, confidence, reason = score_by_domain(domain, inputs)
    if recommendation == 'BLOCK':
        return {'message_type': 'Objection', 'severity': 'high', 'reason': reason, 'recommendation': 'BLOCK'}
    return {
        'message_type': 'Evaluation',
        'severity': 'low',
        'reason': reason,
        'recommendation': recommendation,
        'confidence': confidence,
    }


try:
    from crewai import Agent, Task, Crew

    def build_crew(inputs: JsonDict):
        """Build a CrewAI crew for compliance review, with LLM if available."""
        api_key = os.environ.get('OPENAI_API_KEY', '')

        if not api_key:

            class DeterministicCrew:
                def kickoff(self) -> JsonDict:
                    return _score_result(inputs)

            return DeterministicCrew()

        agent_kwargs: JsonDict = {
            'role': 'Compliance Analyst',
            'goal': 'Review transactions for policy and regulatory compliance',
            'backstory': (
                'You are a compliance analyst reviewing transactions for KYC/AML and '
                'policy adherence. You flag issues with severity ratings. '
                'Respond with a JSON object containing: message_type (Evaluation or Objection), '
                'recommendation (APPROVE/REVIEW/BLOCK), confidence (0-1), reason, and severity.'
            ),
            'verbose': False,
            'allow_delegation': False,
        }

        try:
            from langchain_openai import ChatOpenAI
            agent_kwargs['llm'] = ChatOpenAI(model='gpt-4o-mini', temperature=0, api_key=api_key)
        except ImportError:
            pass

        compliance_analyst = Agent(**agent_kwargs)

        review_task = Task(
            description=(
                f"Review the following transaction for compliance:\n"
                f"- Device trust score: {inputs.get('device_trust_score', 'unknown')}\n"
                f"- Transaction amount: {inputs.get('transaction_amount', 'unknown')}\n"
                f"- Account age (days): {inputs.get('account_age_days', 'unknown')}\n"
                f"- Prior chargebacks: {inputs.get('prior_chargebacks', 'unknown')}\n"
                "Provide a compliance assessment as JSON with: "
                "message_type, recommendation, confidence, reason, severity."
            ),
            expected_output=(
                'JSON with message_type (Evaluation or Objection), severity, reason, recommendation, and confidence'
            ),
            agent=compliance_analyst,
        )

        crew = Crew(
            agents=[compliance_analyst],
            tasks=[review_task],
            verbose=False,
        )

        return crew

    HAS_CREWAI = True

except ImportError:

    HAS_CREWAI = False

    def build_crew(inputs: JsonDict):
        """Fallback: returns a callable that mimics crew.kickoff()."""

        class FallbackCrew:
            usage_metrics = {}

            def kickoff(self) -> JsonDict:
                return _score_result(inputs)

        return FallbackCrew()
