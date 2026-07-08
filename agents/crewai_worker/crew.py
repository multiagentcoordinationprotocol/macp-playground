"""CrewAI compliance review crew.

When crewai and langchain-openai are installed and OPENAI_API_KEY is set,
this builds a real Crew with an LLM-powered Agent. Otherwise, falls back
to deterministic logic.
"""

import os
from typing import Any, Dict

JsonDict = Dict[str, Any]

try:
    from crewai import Agent, Task, Crew

    def build_crew(inputs: JsonDict):
        """Build a CrewAI crew for compliance review, with LLM if available."""
        api_key = os.environ.get('OPENAI_API_KEY', '')

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

        if api_key:
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
                trust = float(inputs.get('device_trust_score', 0.0))
                amount = float(inputs.get('transaction_amount', 0.0))
                account_age_days = int(inputs.get('account_age_days', 0))
                chargebacks = int(inputs.get('prior_chargebacks', 0))

                if trust <= 0.08 or chargebacks >= 2 or (amount >= 3000 and account_age_days < 7):
                    return {
                        'message_type': 'Objection',
                        'severity': 'high',
                        'reason': 'policy checks require additional verification before approval',
                        'recommendation': 'BLOCK',
                    }

                return {
                    'message_type': 'Evaluation',
                    'severity': 'low',
                    'reason': 'compliance checks pass with a step-up recommendation for documentation hygiene',
                    'recommendation': 'REVIEW',
                    'confidence': 0.76,
                }

        return FallbackCrew()
