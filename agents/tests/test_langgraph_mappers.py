"""Tests for the LangGraph worker's pure kickoff/state mappers."""

from langgraph_worker.mappers import map_kickoff_to_state, map_state_to_macp_messages

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
