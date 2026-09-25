"""Tests for the LangGraph worker's pure kickoff/state mappers."""

import logging

from langgraph_worker.graph import _score_result, build_graph
from langgraph_worker.mappers import (
    build_prompt,
    detect_domain,
    extract_agent_metadata,
    map_kickoff_to_state,
    map_state_to_macp_messages,
    score_by_domain,
    score_claims,
    score_fraud,
    score_lending,
)

FULL_CONTEXT = {
    'deviceTrustScore': 0.12,
    'priorChargebacks': 2,
    'transactionAmount': 3200,
    'accountAgeDays': 5,
    'isVipCustomer': True,
}


class TestMapKickoffToState:
    def test_maps_camel_case_context_to_snake_case_state(self):
        state = map_kickoff_to_state(FULL_CONTEXT)

        assert state['device_trust_score'] == 0.12
        assert state['prior_chargebacks'] == 2
        assert state['transaction_amount'] == 3200.0
        assert state['account_age_days'] == 5
        assert state['is_vip_customer'] is True

    def test_initializes_empty_output_fields(self):
        state = map_kickoff_to_state(FULL_CONTEXT)

        assert state['recommendation'] == ''
        assert state['confidence'] == 0.0
        assert state['reason'] == ''
        assert state['signals'] == []

    def test_defaults_for_empty_context(self):
        state = map_kickoff_to_state({})

        assert state['device_trust_score'] == 0.0
        assert state['prior_chargebacks'] == 0
        assert state['transaction_amount'] == 0.0
        assert state['account_age_days'] == 0
        assert state['is_vip_customer'] is False

    def test_none_values_coerce_to_zero_instead_of_raising(self):
        state = map_kickoff_to_state({'deviceTrustScore': None, 'transactionAmount': None, 'accountAgeDays': None})

        assert state['device_trust_score'] == 0.0
        assert state['transaction_amount'] == 0.0
        assert state['account_age_days'] == 0

    def test_casts_numeric_strings(self):
        state = map_kickoff_to_state({'transactionAmount': '99.5', 'accountAgeDays': '30'})

        assert state['transaction_amount'] == 99.5
        assert state['account_age_days'] == 30


class TestMapStateToMacpMessages:
    def test_emits_single_evaluation_message(self):
        messages = map_state_to_macp_messages(
            {'recommendation': 'REJECT', 'confidence': 0.9, 'reason': 'new device', 'signals': ['low-trust']},
            proposal_id='p-1',
            participant_id='fraud-agent',
            recipients=['risk-agent'],
            framework='langgraph',
            agent_ref='fraud-agent',
        )

        assert len(messages) == 1
        message = messages[0]
        assert message['from'] == 'fraud-agent'
        assert message['to'] == ['risk-agent']
        assert message['messageType'] == 'Evaluation'
        proto = message['payloadEnvelope']['proto']
        assert proto['typeName'] == 'macp.modes.decision.v1.EvaluationPayload'
        assert proto['value'] == {
            'proposal_id': 'p-1',
            'recommendation': 'REJECT',
            'confidence': 0.9,
            'reason': 'new device',
        }
        assert message['metadata'] == {
            'framework': 'langgraph',
            'agentRef': 'fraud-agent',
            'hostKind': 'langgraph-process',
            'signals': ['low-trust'],
        }

    def test_defaults_when_graph_output_is_sparse(self):
        messages = map_state_to_macp_messages(
            {},
            proposal_id='p-2',
            participant_id='fraud-agent',
            recipients=[],
            framework='langgraph',
            agent_ref='fraud-agent',
        )

        value = messages[0]['payloadEnvelope']['proto']['value']
        assert value['recommendation'] == 'REVIEW'
        assert value['confidence'] == 0.5
        assert value['reason'] == ''
        assert messages[0]['metadata']['signals'] == []


class TestDetectDomain:
    def test_maps_known_pack_prefixes(self):
        assert detect_domain({'scenario_ref': 'lending/loan-underwriting@1.0.0'}) == 'lending'
        assert detect_domain({'scenario_ref': 'claims/auto-claim-review@1.0.0'}) == 'claims'
        assert detect_domain({'scenario_ref': 'fraud/high-value-new-device@1.0.0'}) == 'fraud'

    def test_defaults_to_fraud_and_warns_on_missing_or_malformed_ref(self, caplog):
        with caplog.at_level(logging.WARNING):
            assert detect_domain({}) == 'fraud'
        assert 'defaulting to fraud' in caplog.text

        caplog.clear()
        with caplog.at_level(logging.WARNING):
            assert detect_domain({'scenario_ref': 'no-slash-here'}) == 'fraud'
        assert 'defaulting to fraud' in caplog.text

        caplog.clear()
        with caplog.at_level(logging.WARNING):
            assert detect_domain({'scenario_ref': 'unknown-pack/some-scenario@1.0.0'}) == 'fraud'
        assert 'defaulting to fraud' in caplog.text


class TestExtractAgentMetadata:
    def test_reads_scenario_ref_and_role(self):
        meta = extract_agent_metadata({'scenario_ref': 'lending/loan-underwriting@1.0.0', 'role': 'credit-analyst'})
        assert meta == {'scenario_ref': 'lending/loan-underwriting@1.0.0', 'role': 'credit-analyst'}

    def test_defaults_for_missing_keys(self):
        assert extract_agent_metadata({}) == {'scenario_ref': '', 'role': ''}
        assert extract_agent_metadata(None) == {'scenario_ref': '', 'role': ''}


class TestFraudCharacterization:
    """Pins today's exact FallbackGraph output (langgraph not installed in CI —
    see agents/requirements-dev.txt) as a regression baseline BEFORE any scoring
    logic is extracted into mappers.py (plans/example-agent-domain-scoring.md
    Phase 2). If these break during the Phase 2 refactor, the refactor changed
    fraud behavior, which Phase 2 explicitly must not do."""

    def test_block_on_critical_device_trust(self):
        state = map_kickoff_to_state({'deviceTrustScore': 0.05, 'priorChargebacks': 0})
        output = build_graph().invoke(state)
        assert output['recommendation'] == 'BLOCK'
        assert output['confidence'] == 0.94

    def test_review_on_low_device_trust(self):
        state = map_kickoff_to_state({'deviceTrustScore': 0.15, 'priorChargebacks': 0})
        output = build_graph().invoke(state)
        assert output['recommendation'] == 'REVIEW'
        assert output['confidence'] == 0.84

    def test_approve_on_clean_signals(self):
        state = map_kickoff_to_state({'deviceTrustScore': 0.5, 'priorChargebacks': 0})
        output = build_graph().invoke(state)
        assert output['recommendation'] == 'APPROVE'
        assert output['confidence'] == 0.72


class TestScoreFraud:
    def test_matches_extracted_characterization_values(self):
        assert score_fraud(0.05, 0) == ('BLOCK', 0.94, 'device trust is critically low for this account history')
        assert score_fraud(0.15, 0) == (
            'REVIEW', 0.84, 'device trust or chargeback history requires manual review',
        )
        assert score_fraud(0.5, 0) == (
            'APPROVE', 0.72, 'fraud signals are within the acceptable range for this session',
        )


class TestScoreLending:
    def test_strong_application_approves_with_qualifying_confidence(self):
        recommendation, confidence, _ = score_lending(720, 0.28, 6, 0)
        assert recommendation == 'APPROVE'
        assert confidence >= 0.6

    def test_weak_application_rejects_on_prior_defaults_hard_gate(self):
        recommendation, confidence, reason = score_lending(550, 0.55, 0, 2)
        assert recommendation == 'REJECT'
        assert confidence >= 0.6
        assert confidence == 0.75
        assert '2' in reason

    def test_missing_field_returns_review(self):
        assert score_lending(None, 0.28, 6, 0) == ('REVIEW', 0.5, 'insufficient data')

    def test_result_is_always_within_allowed_vocabulary(self):
        for credit_score in (500, 580, 650, 720, 800):
            for dti in (0.10, 0.20, 0.30, 0.43, 0.55):
                for years in (0, 2, 5, 10):
                    for defaults in (0, 1):
                        recommendation, confidence, _ = score_lending(credit_score, dti, years, defaults)
                        assert recommendation in ('APPROVE', 'REJECT', 'REVIEW')
                        assert 0.0 <= confidence <= 1.0


class TestScoreClaims:
    def test_clear_minor_claim_approves_with_qualifying_confidence(self):
        recommendation, confidence, _ = score_claims(2000, 24, 0, False, 'minor')
        assert recommendation == 'APPROVE'
        assert confidence >= 0.6

    def test_severe_high_value_out_of_pattern_claim_rejects(self):
        recommendation, confidence, _ = score_claims(50000, 2, 3, True, 'severe')
        assert recommendation == 'REJECT'
        assert confidence >= 0.6

    def test_missing_field_returns_review(self):
        assert score_claims(2000, None, 0, False, 'minor') == ('REVIEW', 0.5, 'insufficient data')

    def test_unrecognized_severity_returns_review(self):
        assert score_claims(2000, 24, 0, False, 'catastrophic') == ('REVIEW', 0.5, 'insufficient data')

    def test_result_is_always_within_allowed_vocabulary(self):
        for amount in (500, 5000, 50000):
            for age in (0, 6, 24, 48):
                for prior in (0, 1, 3):
                    for high_value in (True, False):
                        for severity in ('minor', 'moderate', 'severe', 'total_loss'):
                            recommendation, confidence, _ = score_claims(amount, age, prior, high_value, severity)
                            assert recommendation in ('APPROVE', 'REJECT', 'REVIEW')
                            assert 0.0 <= confidence <= 1.0


class TestScoreByDomain:
    def test_dispatches_to_lending(self):
        fields = {'credit_score': 720, 'debt_to_income_ratio': 0.28, 'employment_years': 6, 'prior_defaults': 0}
        assert score_by_domain('lending', fields) == score_lending(720, 0.28, 6, 0)

    def test_dispatches_to_claims(self):
        fields = {
            'claim_amount': 2000, 'policy_age': 24, 'prior_claims': 0,
            'is_high_value_policy': False, 'incident_severity': 'minor',
        }
        assert score_by_domain('claims', fields) == score_claims(2000, 24, 0, False, 'minor')

    def test_dispatches_to_fraud_by_default(self):
        fields = {'device_trust_score': 0.5, 'prior_chargebacks': 0}
        assert score_by_domain('fraud', fields) == score_fraud(0.5, 0)


class TestBothCallSitesDelegate:
    """AC#7: both the framework-available (no-API-key) and
    framework-unavailable fallback call sites delegate to the same
    mappers.score_by_domain via graph.py's module-level `_score_result`,
    proven directly for the one reachable entry point in this environment
    (FallbackGraph.invoke). The other entry point (llm_recommendation's
    no-api-key branch, inside the try: block gated on langgraph/
    langchain_openai — unreachable here, see agents/requirements-dev.txt)
    is a one-line `return _score_result(state)` call to the identical
    function, confirmed by reading graph.py directly."""

    def test_fallback_output_matches_shared_function_directly(self):
        state = map_kickoff_to_state({'deviceTrustScore': 0.5, 'priorChargebacks': 0})
        direct = _score_result(state)
        via_fallback = build_graph().invoke(state)
        assert via_fallback['recommendation'] == direct['recommendation']
        assert via_fallback['confidence'] == direct['confidence']
        assert via_fallback['reason'] == direct['reason']

    def test_lending_domain_routes_through_fallback_identically(self):
        state = map_kickoff_to_state(
            {'creditScore': 720, 'debtToIncomeRatio': 0.28, 'employmentYears': 6, 'priorDefaults': 0},
            {'scenario_ref': 'lending/loan-underwriting@1.0.0'},
        )
        direct = _score_result(state)
        via_fallback = build_graph().invoke(state)
        assert via_fallback['recommendation'] == direct['recommendation'] == 'APPROVE'
        assert via_fallback['confidence'] == direct['confidence']


class TestBuildPrompt:
    def test_fraud_prompt_unchanged_from_original(self):
        state = map_kickoff_to_state({'deviceTrustScore': 0.5, 'priorChargebacks': 0})
        prompt = build_prompt('fraud', state)
        assert prompt == (
            "You are a fraud detection analyst. Based on the following signals and transaction data, "
            "provide a fraud assessment.\n\n"
            "Signals detected: none\n"
            "Device trust score: 0.5\n"
            "Prior chargebacks: 0\n"
            "Transaction amount: $0.0\n"
            "Account age: 0 days\n"
            "VIP customer: False\n\n"
            "Respond with ONLY a JSON object (no markdown): "
            '{"recommendation": "APPROVE"|"REVIEW"|"BLOCK", "confidence": 0.0-1.0, "reason": "brief explanation"}'
        )

    def test_lending_prompt_has_lending_fields_and_no_fraud_mention(self):
        state = map_kickoff_to_state(
            {'creditScore': 720, 'debtToIncomeRatio': 0.28, 'employmentYears': 6, 'priorDefaults': 0}
        )
        prompt = build_prompt('lending', state)
        assert 'Credit score' in prompt
        assert 'Debt-to-income' in prompt
        assert 'Employment' in prompt
        assert 'fraud' not in prompt.lower()

    def test_claims_prompt_has_claims_fields_and_no_fraud_mention(self):
        state = map_kickoff_to_state(
            {'claimAmount': 2000, 'policyAge': 24, 'priorClaims': 0, 'isHighValuePolicy': False,
             'incidentSeverity': 'minor'}
        )
        prompt = build_prompt('claims', state)
        assert 'Claim amount' in prompt
        assert 'Policy age' in prompt
        assert 'Incident severity' in prompt
        assert 'fraud' not in prompt.lower()

    def test_unrecognized_domain_falls_back_to_a_valid_nonempty_fraud_prompt(self):
        prompt = build_prompt('bogus-domain', {})
        assert prompt
        assert 'fraud detection analyst' in prompt
