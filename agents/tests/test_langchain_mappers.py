"""Tests for the LangChain worker's pure kickoff/result mappers."""

from langchain_worker.mappers import map_kickoff_to_inputs, map_result_to_macp_messages


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
