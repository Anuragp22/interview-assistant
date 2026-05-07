"""Smoke test: package imports and exposes the expected version."""

import interview_agent


def test_package_importable():
    assert hasattr(interview_agent, "__version__")
    assert interview_agent.__version__ == "0.1.0"
