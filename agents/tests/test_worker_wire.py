"""Wire-level guards for the three worker entrypoints (``agents/*_worker/main.py``).

Unlike the mapper tests, these load each worker's real ``main.py`` and drive its registered
``Proposal`` handler against a fake participant, so they pin what actually reaches
``ctx.actions`` — and they classify real ``macp_sdk.errors.MacpAckError`` objects, so a change
in the SDK's error shape fails here rather than in a live session.
"""

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from macp_sdk.errors import AckFailure, MacpAckError, PolicyDenial

AGENTS = Path(__file__).resolve().parent.parent

# worker package -> (builder attribute in main.py, how to fake its output)
WORKERS = {
    'langgraph_worker': 'build_graph',
    'langchain_worker': 'build_agent',
    'crewai_worker': 'build_crew',
}
# Each main.py imports its siblings by bare name, and the three workers share those names.
_SIBLINGS = ('graph', 'chain', 'crew', 'mappers')

# Rev 4 S7 (runtime 0.9.0): Decision enums are case-exact. Anything else is INVALID_ENVELOPE.
VOTE_ENUM = {'APPROVE', 'REJECT'}
EVALUATION_ENUM = {'APPROVE', 'REVIEW', 'BLOCK', 'REJECT'}

# What a framework (or an LLM) might hand back: canonical, lower/mixed case, synonyms, junk.
RAW_RECOMMENDATIONS = [
    'APPROVE', 'approve', 'Allow', 'accept', 'pass',
    'REJECT', 'deny', 'Decline', 'fail',
    'BLOCK', 'veto',
    'REVIEW', 'review', 'escalate', '', 'n/a',
]


def _load_main(worker: str):
    wdir = AGENTS / worker
    for name in _SIBLINGS:
        sys.modules.pop(name, None)
    sys.path.insert(0, str(wdir))
    try:
        spec = importlib.util.spec_from_file_location(f'{worker}_main_under_test', wdir / 'main.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(wdir))
        for name in _SIBLINGS:
            sys.modules.pop(name, None)
    return module


@pytest.fixture(params=sorted(WORKERS), scope='module')
def worker(request):
    return request.param, _load_main(request.param)


def _ack_error(code: str, **kwargs) -> MacpAckError:
    return MacpAckError(AckFailure(code=code, message='m', session_id='s', message_id='x', **kwargs))


class TestIsSessionClosed:
    @pytest.mark.parametrize('code', ['SESSION_NOT_OPEN', 'SESSION_NOT_FOUND'])
    def test_session_closed_codes(self, worker, code):
        _, main = worker
        assert main._is_session_closed(_ack_error(code)) is True

    def test_session_not_found_is_closed_even_with_a_message_naming_nothing(self, worker):
        # The runtime reports an unknown session as SESSION_NOT_FOUND. The old substring list
        # ("UNKNOWN_SESSION", "TTL_EXPIRED") never matched it, so this NACK was raised as a failure.
        _, main = worker
        err = MacpAckError(AckFailure(code='SESSION_NOT_FOUND', message='no such session', session_id='s',
                                      message_id='x'))
        assert main._is_session_closed(err) is True

    @pytest.mark.parametrize('code', ['POLICY_DENIED', 'INVALID_ENVELOPE', 'FORBIDDEN', 'UNAUTHENTICATED'])
    def test_other_codes_are_not_closed(self, worker, code):
        _, main = worker
        assert main._is_session_closed(_ack_error(code)) is False

    def test_policy_denied_with_denials_is_not_closed(self, worker):
        _, main = worker
        err = _ack_error('POLICY_DENIED', denials=[PolicyDenial(code='veto', message='blocked', participants=['a'])])
        assert main._is_session_closed(err) is False

    def test_structured_code_wins_over_message_text(self, worker):
        # A message that merely mentions SESSION_NOT_OPEN does not make a POLICY_DENIED NACK terminal.
        _, main = worker
        err = MacpAckError(AckFailure(code='POLICY_DENIED', message='after SESSION_NOT_OPEN race', session_id='s',
                                      message_id='x'))
        assert main._is_session_closed(err) is False


class _Actions:
    _mode = 'macp.mode.decision.v1'
    _session_id = 'sess-1'
    _participant_id = 'agent-under-test'

    def __init__(self):
        self.votes = []
        self.evaluations = []

    def vote(self, proposal_id, vote, reason=''):
        self.votes.append(vote)

    def evaluate(self, proposal_id, recommendation, confidence=0.0, reason=''):
        self.evaluations.append(recommendation)

    def send_envelope(self, envelope):
        pass


class _Participant:
    def __init__(self):
        self.handlers = {}

    def on(self, message_type, handler):
        self.handlers[message_type] = handler

    def run(self):
        pass

    def stop(self):
        pass


def _fake_builder(worker: str, recommendation: str):
    result = {'recommendation': recommendation, 'confidence': 0.9, 'reason': 'r'}
    runner = SimpleNamespace(invoke=lambda _inputs: dict(result), kickoff=lambda: dict(result))
    if worker == 'crewai_worker':
        return lambda _inputs: runner
    return lambda: runner


@pytest.mark.parametrize('raw', RAW_RECOMMENDATIONS)
def test_vote_and_evaluation_are_upper_case_enum_members(worker, raw, monkeypatch):
    name, main = worker
    participant = _Participant()
    monkeypatch.delenv('MACP_BOOTSTRAP_FILE', raising=False)  # no peers -> the vote is released at once
    monkeypatch.setattr(main, 'from_bootstrap', lambda: participant)
    monkeypatch.setattr(main, WORKERS[name], _fake_builder(name, raw))
    assert main.main() == 0

    actions = _Actions()
    proposal = SimpleNamespace(proposal_id='p-1', sender='coordinator')
    participant.handlers['Proposal'](proposal, SimpleNamespace(actions=actions))

    assert len(actions.evaluations) == 1 and len(actions.votes) == 1, (actions.evaluations, actions.votes)
    assert actions.evaluations[0] in EVALUATION_ENUM, f'{name}: evaluation {actions.evaluations[0]!r} from {raw!r}'
    assert actions.votes[0] in VOTE_ENUM, f'{name}: vote {actions.votes[0]!r} from {raw!r}'
