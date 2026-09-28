"""CrewAI compliance review crew.

When crewai and langchain-openai are installed and OPENAI_API_KEY is set,
this builds a real Crew with an LLM-powered Agent. Otherwise, falls back
to deterministic logic.
"""

import logging
import os
from typing import Any, Dict

try:
    from mappers import build_prompt, score_by_domain
except ImportError:
    from .mappers import build_prompt, score_by_domain

JsonDict = Dict[str, Any]

logger = logging.getLogger('macp.agent')

# Imported at module scope, in its own try, so the outcome is an assertable flag rather than a
# silently swallowed failure inside build_crew(). It must NOT share the crewai try below: a
# missing langchain-openai is a *degraded* crewai worker, not an absent one, so it must not flip
# HAS_CREWAI. Nothing on a constructed Crew can reveal this — crewai coerces whatever `llm` it
# is handed into its own crewai.llm.LLM and validates nothing, so type(crew).__name__ stays
# 'Crew' even when the LLM has been dropped entirely (measured against crewai 0.203.2). The flag
# is therefore the only way CI can gate it; see the construct smoke in .github/workflows/ci.yml.
#
# Cost, measured so nobody has to guess: importing langchain_openai eagerly rather than inside
# build_crew() adds ~0.8s to module import (3.0s -> 3.8s) on the keyless path, which previously
# skipped it. Paid once per worker process spawn, against a worker that then opens a gRPC channel
# and runs an LLM turn — worth it to make a silent-degradation hazard gateable.
try:
    from langchain_openai import ChatOpenAI

    HAS_LANGCHAIN_OPENAI = True
    LANGCHAIN_OPENAI_IMPORT_ERROR = ''
except ImportError as err:
    ChatOpenAI = None
    HAS_LANGCHAIN_OPENAI = False
    LANGCHAIN_OPENAI_IMPORT_ERROR = str(err)


def _warn_langchain_openai_unavailable() -> None:
    """Loud on purpose, and a module-level function rather than an inline call so it is reachable
    from a test in any install state. An agent answering from crewai's own default LLM instead of
    the configured one is indistinguishable, in its output, from one answering correctly — so
    silence here is worse than a crash."""
    logger.warning(
        "langchain-openai unavailable (%s) — the crewai agent will fall back to crewai's "
        'own default LLM. This is a DEGRADED path, not a keyless run.',
        LANGCHAIN_OPENAI_IMPORT_ERROR,
    )


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

        domain = inputs.get('domain', 'fraud')
        backstory, task_description = build_prompt(domain, inputs)

        agent_kwargs: JsonDict = {
            'role': 'Compliance Analyst',
            'goal': 'Review transactions for policy and regulatory compliance',
            'backstory': backstory,
            'verbose': False,
            'allow_delegation': False,
        }

        if HAS_LANGCHAIN_OPENAI:
            agent_kwargs['llm'] = ChatOpenAI(model='gpt-4o-mini', temperature=0, api_key=api_key)
        else:
            _warn_langchain_openai_unavailable()

        compliance_analyst = Agent(**agent_kwargs)

        review_task = Task(
            description=task_description,
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
