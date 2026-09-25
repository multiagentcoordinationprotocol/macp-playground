"""Tests for the CrewAI worker's pure kickoff/result mappers."""

import logging

from crewai_worker.crew import build_crew
from crewai_worker.mappers import (
    detect_domain,
    extract_agent_metadata,
    map_crew_result_to_macp_messages,
    map_kickoff_to_crew_inputs,
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

        assert inputs == {
            'device_trust_score': 0.12,
            'transaction_amount': 3200.0,
            'account_age_days': 5,
            'prior_chargebacks': 1,
            'is_vip_customer': True,
        }

    def test_defaults_for_empty_context(self):
        assert map_kickoff_to_crew_inputs({}) == {
            'device_trust_score': 0.0,
            'transaction_amount': 0.0,
            'account_age_days': 0,
            'prior_chargebacks': 0,
            'is_vip_customer': False,
        }

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
