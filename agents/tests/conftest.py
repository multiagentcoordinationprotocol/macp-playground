"""Shared pytest setup for the worker mapper tests."""

import pytest


@pytest.fixture(autouse=True)
def _no_llm_key(monkeypatch):
    """Keep every test on the deterministic path, whatever the developer's shell exports.

    Each worker switches from its deterministic ``Fallback*`` scorer to a real LLM call as soon as
    ``OPENAI_API_KEY`` is non-empty, so with a key exported these tests either hit the network or
    fail on a rejected key. CI runs with the key empty, which is the behaviour pinned here. Tests
    that need a key (the framework-construct smoke lives in CI, not here) set one explicitly.
    """
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
