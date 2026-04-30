"""Tests for advisory lock mechanism."""
import pytest

from src.advisory_lock import hash_property_layer


def test_hash_property_layer():
    """Test advisory lock ID hashing."""
    # Same inputs should produce same hash
    hash1 = hash_property_layer("prop-123", "demand")
    hash2 = hash_property_layer("prop-123", "demand")

    assert hash1 == hash2


def test_hash_property_layer_distinct():
    """Test that different inputs produce different hashes."""
    hash_demand = hash_property_layer("prop-123", "demand")
    hash_supply = hash_property_layer("prop-123", "supply")

    # Different layer should produce different hash
    assert hash_demand != hash_supply

    hash_prop2 = hash_property_layer("prop-456", "demand")
    # Different property should produce different hash
    assert hash_demand != hash_prop2


def test_hash_property_layer_positive():
    """Test that hashes are positive (31-bit)."""
    hash_val = hash_property_layer("prop-123", "demand")

    assert hash_val >= 0
    assert hash_val <= 0x7FFFFFFF  # 31-bit signed int max
