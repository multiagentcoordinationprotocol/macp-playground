"""LangGraph fraud detection graph.

When langgraph and langchain-openai are installed, this builds a real StateGraph
with an LLM-powered recommendation node. Otherwise, falls back to deterministic logic.
"""

import json
import os
from typing import Any, Dict, List, TypedDict

try:
    from mappers import build_prompt, score_by_domain
except ImportError:
    from .mappers import build_prompt, score_by_domain

JsonDict = Dict[str, Any]


def _score_result(state: JsonDict) -> JsonDict:
    """Delegate to mappers.score_by_domain — the single implementation the
    framework-available (no-API-key) and framework-unavailable fallback paths
    both call, eliminating what were two duplicate inline copies of this
    branching logic (plans/example-agent-domain-scoring.md Phase 2)."""
    domain = state.get('domain', 'fraud')
    recommendation, confidence, reason = score_by_domain(domain, state)
    return {'recommendation': recommendation, 'confidence': confidence, 'reason': reason}


try:
    from langgraph.graph import StateGraph, END
    from langchain_openai import ChatOpenAI

    class FraudState(TypedDict):
        device_trust_score: float
        prior_chargebacks: int
        transaction_amount: float
        account_age_days: int
        is_vip_customer: bool
        recommendation: str
        confidence: float
        reason: str
        signals: List[str]
        token_usage: dict

    def evaluate_device_trust(state: FraudState) -> dict:
        signals = list(state.get('signals', []))
        trust = state['device_trust_score']
        if trust < 0.08:
            signals.append('critical_device_trust')
        elif trust < 0.2:
            signals.append('low_device_trust')
        return {'signals': signals}

    def evaluate_chargeback_history(state: FraudState) -> dict:
        signals = list(state.get('signals', []))
        chargebacks = state['prior_chargebacks']
        if chargebacks >= 2:
            signals.append('high_chargeback_risk')
        elif chargebacks >= 1:
            signals.append('moderate_chargeback_risk')
        return {'signals': signals}

    def llm_recommendation(state: FraudState) -> dict:
        """Use gpt-4o-mini to make a fraud recommendation based on signals."""
        api_key = os.environ.get('OPENAI_API_KEY', '')
        if not api_key:
            # No API key — fall back to deterministic logic
            return _score_result(state)

        llm = ChatOpenAI(model='gpt-4o-mini', temperature=0, api_key=api_key)
        domain = state.get('domain', 'fraud')
        prompt = build_prompt(domain, state)

        response = llm.invoke(prompt)

        # Extract token usage
        usage = response.usage_metadata or {}
        token_usage = {
            'promptTokens': usage.get('input_tokens', 0),
            'completionTokens': usage.get('output_tokens', 0),
            'model': 'gpt-4o-mini',
        }

        # Parse the LLM response
        try:
            content = response.content.strip()
            if content.startswith('```'):
                content = content.split('\n', 1)[1].rsplit('```', 1)[0].strip()
            parsed = json.loads(content)
            return {
                'recommendation': parsed.get('recommendation', 'REVIEW').upper(),
                'confidence': float(parsed.get('confidence', 0.8)),
                'reason': parsed.get('reason', 'LLM-based fraud assessment'),
                'token_usage': token_usage,
            }
        except (json.JSONDecodeError, ValueError):
            return {
                'recommendation': 'REVIEW',
                'confidence': 0.7,
                'reason': str(response.content)[:200],
                'token_usage': token_usage,
            }

    def build_graph() -> StateGraph:
        """Build the LangGraph fraud evaluation graph with LLM recommendation."""
        graph = StateGraph(FraudState)
        graph.add_node('evaluate_device_trust', evaluate_device_trust)
        graph.add_node('evaluate_chargeback_history', evaluate_chargeback_history)
        graph.add_node('llm_recommendation', llm_recommendation)
        graph.set_entry_point('evaluate_device_trust')
        graph.add_edge('evaluate_device_trust', 'evaluate_chargeback_history')
        graph.add_edge('evaluate_chargeback_history', 'llm_recommendation')
        graph.add_edge('llm_recommendation', END)
        return graph.compile()

    HAS_LANGGRAPH = True

except ImportError:

    HAS_LANGGRAPH = False

    def build_graph():
        """Fallback: returns a callable that mimics graph.invoke()."""

        class FallbackGraph:
            def invoke(self, state: JsonDict) -> JsonDict:
                domain = state.get('domain', 'fraud')
                signals: List[str] = []

                if domain == 'fraud':
                    trust = float(state.get('device_trust_score', 0.0))
                    chargebacks = int(state.get('prior_chargebacks', 0))

                    if trust < 0.08:
                        signals.append('critical_device_trust')
                    elif trust < 0.2:
                        signals.append('low_device_trust')

                    if chargebacks >= 2:
                        signals.append('high_chargeback_risk')
                    elif chargebacks >= 1:
                        signals.append('moderate_chargeback_risk')

                return {**state, 'signals': signals, **_score_result(state)}

        return FallbackGraph()
