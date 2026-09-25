"""Tests for the CrewAI worker's pure kickoff/result mappers."""

import logging

from crewai_worker.crew import _score_result, build_crew
from crewai_worker.mappers import (
    detect_domain,
    extract_agent_metadata,
    map_crew_result_to_macp_messages,
    map_kickoff_to_crew_inputs,
    score_by_domain,
    score_claims,
    score_fraud,
    score_lending,
)


class TestMapKickoffToCrewInputs:
    def test_maps_camel_case_context_to_snake_case_inputs(self):
        inputs = map_kickoff_to_crew_inputs(
            {
                'deviceTrustScore': 0.12,
                'transactionAmount': 3200,
                'accountAgeDays': 5,
                'priorChargebacks': 1,
                'isVipCustomer': True,
            }
        )

        assert inputs['device_trust_score'] == 0.12
        assert inputs['transaction_amount'] == 3200.0
        assert inputs['account_age_days'] == 5
        assert inputs['prior_chargebacks'] == 1
        assert inputs['is_vip_customer'] is True

    def test_defaults_for_empty_context(self):
        inputs = map_kickoff_to_crew_inputs({})
        assert inputs['device_trust_score'] == 0.0
        assert inputs['transaction_amount'] == 0.0
        assert inputs['account_age_days'] == 0
        assert inputs['prior_chargebacks'] == 0
        assert inputs['is_vip_customer'] is False

    def test_domain_specific_fields_default_to_none_when_absent(self):
        inputs = map_kickoff_to_crew_inputs({})
        for field in (
            'credit_score', 'debt_to_income_ratio', 'employment_years', 'prior_defaults',
            'claim_amount', 'policy_age', 'prior_claims', 'is_high_value_policy', 'incident_severity',
        ):
            assert inputs[field] is None

    def test_none_values_coerce_to_zero_instead_of_raising(self):
        inputs = map_kickoff_to_crew_inputs({'deviceTrustScore': None, 'accountAgeDays': None})

        assert inputs['device_trust_score'] == 0.0
        assert inputs['account_age_days'] == 0


COMMON_ARGS = {
    'proposal_id': 'p-1',
    'participant_id': 'compliance-agent',
    'recipients': ['risk-agent'],
    'framework': 'crewai',
    'agent_ref': 'compliance-agent',
}


class TestMapCrewResultToMacpMessages:
    def test_emits_evaluation_message_for_dict_output(self):
        messages = map_crew_result_to_macp_messages(
            {'message_type': 'Evaluation', 'recommendation': 'APPROVE', 'confidence': 0.9, 'reason': 'compliant'},
            **COMMON_ARGS,
        )

        assert len(messages) == 1
        message = messages[0]
        assert message['messageType'] == 'Evaluation'
        proto = message['payloadEnvelope']['proto']
        assert proto['typeName'] == 'macp.modes.decision.v1.EvaluationPayload'
        assert proto['value'] == {
            'proposal_id': 'p-1',
            'recommendation': 'APPROVE',
            'confidence': 0.9,
            'reason': 'compliant',
        }
        assert message['metadata'] == {
            'framework': 'crewai',
            'agentRef': 'compliance-agent',
            'hostKind': 'crewai-process',
        }

    def test_emits_objection_message_when_crew_objects(self):
        messages = map_crew_result_to_macp_messages(
            {'message_type': 'Objection', 'reason': 'sanctions hit', 'severity': 'critical'},
            **COMMON_ARGS,
        )

        assert len(messages) == 1
        message = messages[0]
        assert message['messageType'] == 'Objection'
        proto = message['payloadEnvelope']['proto']
        assert proto['typeName'] == 'macp.modes.decision.v1.ObjectionPayload'
        assert proto['value'] == {'proposal_id': 'p-1', 'reason': 'sanctions hit', 'severity': 'critical'}

    def test_objection_severity_defaults_to_high(self):
        messages = map_crew_result_to_macp_messages({'message_type': 'Objection'}, **COMMON_ARGS)

        assert messages[0]['payloadEnvelope']['proto']['value']['severity'] == 'high'

    def test_wraps_plain_string_output_as_review_evaluation(self):
        messages = map_crew_result_to_macp_messages('needs a human look', **COMMON_ARGS)

        message = messages[0]
        assert message['messageType'] == 'Evaluation'
        value = message['payloadEnvelope']['proto']['value']
        assert value['recommendation'] == 'REVIEW'
        assert value['confidence'] == 0.5
        assert value['reason'] == 'needs a human look'

    def test_defaults_when_dict_output_is_sparse(self):
        messages = map_crew_result_to_macp_messages({}, **COMMON_ARGS)

        message = messages[0]
        assert message['messageType'] == 'Evaluation'
        value = message['payloadEnvelope']['proto']['value']
        assert value['recommendation'] == 'REVIEW'
        assert value['confidence'] == 0.76


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
        meta = extract_agent_metadata(
            {'scenario_ref': 'fraud/high-value-new-device@1.0.0', 'role': 'compliance-reviewer'}
        )
        assert meta == {'scenario_ref': 'fraud/high-value-new-device@1.0.0', 'role': 'compliance-reviewer'}

    def test_defaults_for_missing_keys(self):
        assert extract_agent_metadata({}) == {'scenario_ref': '', 'role': ''}
        assert extract_agent_metadata(None) == {'scenario_ref': '', 'role': ''}


class TestFraudCharacterization:
    """Pins today's exact FallbackCrew output (crewai not installed in CI) as a
    regression baseline BEFORE any scoring logic is extracted into mappers.py
    (plans/example-agent-domain-scoring.md Phase 2)."""

    def test_objection_block_on_critical_signals(self):
        inputs = map_kickoff_to_crew_inputs({'deviceTrustScore': 0.05, 'priorChargebacks': 0})
        result = build_crew(inputs).kickoff()
        assert result['message_type'] == 'Objection'
        assert result['severity'] == 'high'
        assert result['recommendation'] == 'BLOCK'

    def test_review_on_clean_signals(self):
        inputs = map_kickoff_to_crew_inputs(
            {'deviceTrustScore': 0.5, 'priorChargebacks': 0, 'transactionAmount': 100, 'accountAgeDays': 100}
        )
        result = build_crew(inputs).kickoff()
        assert result['message_type'] == 'Evaluation'
        assert result['recommendation'] == 'REVIEW'
        assert result['confidence'] == 0.76


class TestScoreFraud:
    def test_matches_extracted_characterization_values(self):
        recommendation, confidence, reason = score_fraud(0.05, 0, 100, 100)
        assert recommendation == 'BLOCK'
        assert confidence is None
        assert reason == 'policy checks require additional verification before approval'

        assert score_fraud(0.5, 0, 100, 100) == (
            'REVIEW', 0.76, 'compliance checks pass with a step-up recommendation for documentation hygiene',
        )

    def test_high_amount_new_account_also_blocks(self):
        recommendation, _, _ = score_fraud(0.5, 0, 3000, 6)
        assert recommendation == 'BLOCK'


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
        fields = {
            'device_trust_score': 0.5, 'prior_chargebacks': 0,
            'transaction_amount': 100, 'account_age_days': 100,
        }
        assert score_by_domain('fraud', fields) == score_fraud(0.5, 0, 100, 100)


class TestCrewaiNeverObjectsOnClaims:
    """Phase 2 AC#5: crewai's domain-aware call site never emits an Objection
    message for a claims input, since score_claims never returns 'BLOCK'
    (plans/example-agent-domain-scoring.md Phase 2)."""

    def test_approve_claims_fixture_never_objects(self):
        inputs = map_kickoff_to_crew_inputs(
            {'claimAmount': 2000, 'policyAge': 24, 'priorClaims': 0, 'isHighValuePolicy': False,
             'incidentSeverity': 'minor'},
            {'scenario_ref': 'claims/auto-claim-review@1.0.0'},
        )
        result = build_crew(inputs).kickoff()
        assert result['message_type'] != 'Objection'
        assert result['recommendation'] == 'APPROVE'

    def test_reject_claims_fixture_never_objects(self):
        inputs = map_kickoff_to_crew_inputs(
            {'claimAmount': 50000, 'policyAge': 2, 'priorClaims': 3, 'isHighValuePolicy': True,
             'incidentSeverity': 'severe'},
            {'scenario_ref': 'claims/auto-claim-review@1.0.0'},
        )
        result = build_crew(inputs).kickoff()
        assert result['message_type'] != 'Objection'
        assert result['recommendation'] == 'REJECT'


class TestBothCallSitesDelegate:
    """AC#7: both the framework-available (no-API-key) and
    framework-unavailable fallback call sites delegate to the same
    mappers.score_by_domain via crew.py's module-level `_score_result`,
    proven directly for the one reachable entry point in this environment
    (FallbackCrew.kickoff). The other entry point (build_crew()'s no-api-key
    branch, DeterministicCrew — unreachable here, see
    agents/requirements-dev.txt) is a one-line `return _score_result(inputs)`
    call to the identical function, confirmed by reading crew.py directly."""

    def test_fallback_output_matches_shared_function_directly(self):
        inputs = map_kickoff_to_crew_inputs(
            {'deviceTrustScore': 0.5, 'priorChargebacks': 0, 'transactionAmount': 100, 'accountAgeDays': 100}
        )
        direct = _score_result(inputs)
        via_fallback = build_crew(inputs).kickoff()
        assert via_fallback == direct

    def test_lending_domain_routes_through_fallback_identically(self):
        inputs = map_kickoff_to_crew_inputs(
            {'creditScore': 720, 'debtToIncomeRatio': 0.28, 'employmentYears': 6, 'priorDefaults': 0},
            {'scenario_ref': 'lending/loan-underwriting@1.0.0'},
        )
        direct = _score_result(inputs)
        via_fallback = build_crew(inputs).kickoff()
        assert via_fallback == direct
        assert direct['recommendation'] == 'APPROVE'
