"""Tests for the LangChain worker's pure kickoff/result mappers."""

import logging

from langchain_worker.chain import build_agent
from langchain_worker.mappers import (
    detect_domain,
    extract_agent_metadata,
    map_kickoff_to_inputs,
    map_result_to_macp_messages,
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

        assert inputs == {
            'transaction_amount': 3200.0,
            'is_vip_customer': True,
            'account_age_days': 5,
            'device_trust_score': 0.12,
            'prior_chargebacks': 1,
        }

    def test_defaults_for_empty_context(self):
        assert map_kickoff_to_inputs({}) == {
            'transaction_amount': 0.0,
            'is_vip_customer': False,
            'account_age_days': 0,
            'device_trust_score': 0.0,
            'prior_chargebacks': 0,
        }

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
