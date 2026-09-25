"""Tests for the LangChain worker's pure kickoff/result mappers."""

import logging

from langchain_worker.chain import _score_result, build_agent
from langchain_worker.mappers import (
    build_prompt,
    detect_domain,
    extract_agent_metadata,
    map_kickoff_to_inputs,
    map_result_to_macp_messages,
    score_by_domain,
    score_claims,
    score_fraud,
    score_lending,
)


class TestMapKickoffToInputs:
    def test_maps_camel_case_context_to_snake_case_inputs(self):
        inputs = map_kickoff_to_inputs(
            {
                'transactionAmount': 3200,
                'isVipCustomer': True,
                'accountAgeDays': 5,
                'deviceTrustScore': 0.12,
                'priorChargebacks': 1,
            }
        )

        assert inputs['transaction_amount'] == 3200.0
        assert inputs['is_vip_customer'] is True
        assert inputs['account_age_days'] == 5
        assert inputs['device_trust_score'] == 0.12
        assert inputs['prior_chargebacks'] == 1

    def test_defaults_for_empty_context(self):
        inputs = map_kickoff_to_inputs({})
        assert inputs['transaction_amount'] == 0.0
        assert inputs['is_vip_customer'] is False
        assert inputs['account_age_days'] == 0
        assert inputs['device_trust_score'] == 0.0
        assert inputs['prior_chargebacks'] == 0

    def test_domain_specific_fields_default_to_none_when_absent(self):
        inputs = map_kickoff_to_inputs({})
        for field in (
            'credit_score', 'debt_to_income_ratio', 'employment_years', 'prior_defaults',
            'claim_amount', 'policy_age', 'prior_claims', 'is_high_value_policy', 'incident_severity',
        ):
            assert inputs[field] is None

    def test_none_values_coerce_to_zero_instead_of_raising(self):
        inputs = map_kickoff_to_inputs({'transactionAmount': None, 'priorChargebacks': None})

        assert inputs['transaction_amount'] == 0.0
        assert inputs['prior_chargebacks'] == 0


class TestMapResultToMacpMessages:
    def test_emits_single_evaluation_message(self):
        messages = map_result_to_macp_messages(
            {'recommendation': 'APPROVE', 'confidence': 0.8, 'reason': 'loyal customer', 'factors': ['vip']},
            proposal_id='p-1',
            participant_id='growth-agent',
            recipients=['risk-agent', 'fraud-agent'],
            framework='langchain',
            agent_ref='growth-agent',
        )

        assert len(messages) == 1
        message = messages[0]
        assert message['from'] == 'growth-agent'
        assert message['to'] == ['risk-agent', 'fraud-agent']
        assert message['messageType'] == 'Evaluation'
        proto = message['payloadEnvelope']['proto']
        assert proto['typeName'] == 'macp.modes.decision.v1.EvaluationPayload'
        assert proto['value'] == {
            'proposal_id': 'p-1',
            'recommendation': 'APPROVE',
            'confidence': 0.8,
            'reason': 'loyal customer',
        }
        assert message['metadata'] == {
            'framework': 'langchain',
            'agentRef': 'growth-agent',
            'hostKind': 'langchain-process',
            'factors': ['vip'],
        }

    def test_defaults_when_chain_output_is_sparse(self):
        messages = map_result_to_macp_messages(
            {},
            proposal_id='p-2',
            participant_id='growth-agent',
            recipients=[],
            framework='langchain',
            agent_ref='growth-agent',
        )

        value = messages[0]['payloadEnvelope']['proto']['value']
        assert value['recommendation'] == 'REVIEW'
        assert value['confidence'] == 0.5
        assert value['reason'] == ''
        assert messages[0]['metadata']['factors'] == []

    def test_coerces_confidence_to_float(self):
        messages = map_result_to_macp_messages(
            {'confidence': '0.75'},
            proposal_id='p-3',
            participant_id='growth-agent',
            recipients=[],
            framework='langchain',
            agent_ref='growth-agent',
        )

        assert messages[0]['payloadEnvelope']['proto']['value']['confidence'] == 0.75


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
            assert detect_domain({'scenario_ref': 'unknown-pack/some-scenario@1.0.0'}) == 'fraud'
        assert 'defaulting to fraud' in caplog.text


class TestExtractAgentMetadata:
    def test_reads_scenario_ref_and_role(self):
        meta = extract_agent_metadata({'scenario_ref': 'claims/auto-claim-review@1.0.0', 'role': 'claims-validator'})
        assert meta == {'scenario_ref': 'claims/auto-claim-review@1.0.0', 'role': 'claims-validator'}

    def test_defaults_for_missing_keys(self):
        assert extract_agent_metadata({}) == {'scenario_ref': '', 'role': ''}
        assert extract_agent_metadata(None) == {'scenario_ref': '', 'role': ''}


class TestFraudCharacterization:
    """Pins today's exact FallbackChain output (langchain_core not installed in
    CI) as a regression baseline BEFORE any scoring logic is extracted into
    mappers.py (plans/example-agent-domain-scoring.md Phase 2)."""

    def test_approve_high_on_vip_trusted_profile(self):
        inputs = map_kickoff_to_inputs(
            {'isVipCustomer': True, 'accountAgeDays': 30, 'transactionAmount': 1000}
        )
        output = build_agent().invoke(inputs)
        assert output['recommendation'] == 'APPROVE'
        assert output['confidence'] == 0.88

    def test_review_on_high_amount(self):
        inputs = map_kickoff_to_inputs(
            {'isVipCustomer': False, 'accountAgeDays': 30, 'transactionAmount': 6000}
        )
        output = build_agent().invoke(inputs)
        assert output['recommendation'] == 'REVIEW'
        assert output['confidence'] == 0.73

    def test_approve_standard_on_ordinary_profile(self):
        inputs = map_kickoff_to_inputs(
            {'isVipCustomer': False, 'accountAgeDays': 10, 'transactionAmount': 1000}
        )
        output = build_agent().invoke(inputs)
        assert output['recommendation'] == 'APPROVE'
        assert output['confidence'] == 0.78


class TestScoreFraud:
    def test_matches_extracted_characterization_values(self):
        assert score_fraud(1000, True, 30) == (
            'APPROVE', 0.88, 'customer value is high and the purchase fits a trusted profile',
        )
        assert score_fraud(6000, False, 30) == (
            'REVIEW', 0.73, 'experience goals favor a step-up rather than an outright block',
        )
        assert score_fraud(1000, False, 10) == (
            'APPROVE', 0.78, 'growth impact is favorable with manageable customer friction',
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
        fields = {'transaction_amount': 1000, 'is_vip_customer': True, 'account_age_days': 30}
        assert score_by_domain('fraud', fields) == score_fraud(1000, True, 30)


class TestBothCallSitesDelegate:
    """AC#7: both the framework-available (no-API-key) and
    framework-unavailable fallback call sites delegate to the same
    mappers.score_by_domain via chain.py's module-level `_score_result`,
    proven directly for the one reachable entry point in this environment
    (FallbackChain.invoke). The other entry point (build_agent()'s no-api-key
    branch — unreachable here, see agents/requirements-dev.txt) is a
    one-line `RunnableLambda(_score_result)` call to the identical function,
    confirmed by reading chain.py directly."""

    def test_fallback_output_matches_shared_function_directly(self):
        inputs = map_kickoff_to_inputs({'isVipCustomer': False, 'accountAgeDays': 10, 'transactionAmount': 1000})
        direct = _score_result(inputs)
        via_fallback = build_agent().invoke(inputs)
        assert via_fallback['recommendation'] == direct['recommendation']
        assert via_fallback['confidence'] == direct['confidence']
        assert via_fallback['reason'] == direct['reason']

    def test_lending_domain_routes_through_fallback_identically(self):
        inputs = map_kickoff_to_inputs(
            {'creditScore': 720, 'debtToIncomeRatio': 0.28, 'employmentYears': 6, 'priorDefaults': 0},
            {'scenario_ref': 'lending/loan-underwriting@1.0.0'},
        )
        direct = _score_result(inputs)
        via_fallback = build_agent().invoke(inputs)
        assert via_fallback['recommendation'] == direct['recommendation'] == 'APPROVE'
        assert via_fallback['confidence'] == direct['confidence']


class TestBuildPrompt:
    def test_fraud_prompt_unchanged_from_original(self):
        inputs = map_kickoff_to_inputs({'isVipCustomer': False, 'accountAgeDays': 10, 'transactionAmount': 1000})
        system, human = build_prompt('fraud', inputs)
        assert system == (
            'You are a growth analyst evaluating whether a transaction should be approved, '
            'reviewed, or blocked from a customer value and revenue perspective. '
            'Balance fraud risk against customer experience and retention. '
            'Respond with ONLY a JSON object (no markdown): '
            '{{"recommendation": "APPROVE"|"REVIEW"|"BLOCK", "confidence": 0.0-1.0, '
            '"reason": "brief explanation", "factors": ["factor1", "factor2"]}}'
        )
        assert human == (
            'Transaction: $1000.0\n'
            'VIP customer: False\n'
            'Account age: 10 days\n'
            'Device trust: 0.0\n'
            'Prior chargebacks: 0'
        )

    def test_lending_prompt_has_lending_fields_and_no_fraud_mention(self):
        inputs = map_kickoff_to_inputs(
            {'creditScore': 720, 'debtToIncomeRatio': 0.28, 'employmentYears': 6, 'priorDefaults': 0}
        )
        system, human = build_prompt('lending', inputs)
        assert 'Credit score' in human
        assert 'Debt-to-income' in human
        assert 'Employment' in human
        assert 'fraud' not in (system + human).lower()

    def test_claims_prompt_has_claims_fields_and_no_fraud_mention(self):
        inputs = map_kickoff_to_inputs(
            {'claimAmount': 2000, 'policyAge': 24, 'priorClaims': 0, 'isHighValuePolicy': False,
             'incidentSeverity': 'minor'}
        )
        system, human = build_prompt('claims', inputs)
        assert 'Claim amount' in human
        assert 'Policy age' in human
        assert 'Incident severity' in human
        assert 'fraud' not in (system + human).lower()

    def test_unrecognized_domain_falls_back_to_a_valid_nonempty_fraud_prompt(self):
        system, human = build_prompt('bogus-domain', {})
        assert system and human
        assert 'growth analyst' in system
