import json
import os
import tempfile
import unittest

os.environ.setdefault("BOT_TOKEN", "test-token")
os.environ.setdefault("PULL_SECRET", "test-secret")

from app import Relay, validate_web_command  # noqa: E402


def update(update_id: int) -> dict:
    return {
        "update_id": update_id,
        "message": {
            "message_id": update_id,
            "date": 0,
            "chat": {"id": 1, "type": "private"},
            "from": {"id": 1, "is_bot": False, "first_name": "Test"},
            "text": "ping",
        },
    }


class CursorRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        handle = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        handle.close()
        self.path = handle.name
        self.relay = Relay(self.path)

    def tearDown(self) -> None:
        self.relay.db.close()
        os.unlink(self.path)

    def test_normal_acknowledgement_removes_processed_update(self) -> None:
        self.relay.store(update(1000))
        self.assertEqual([item["update_id"] for item in self.relay.deliverable(0)], [1000])
        self.assertEqual(self.relay.deliverable(1001), [])
        self.assertEqual(self.relay.db.execute("SELECT COUNT(*) FROM updates").fetchone()[0], 0)

    def test_poisoned_future_cursor_does_not_delete_real_update(self) -> None:
        self.relay.store(update(1001))
        batch = self.relay.deliverable(5000)
        self.assertEqual([item["update_id"] for item in batch], [1001])
        self.assertEqual(self.relay.db.execute("SELECT COUNT(*) FROM updates").fetchone()[0], 1)

        # The client repairs its cursor to the returned id, processes it, and
        # acknowledges it on the following pull.
        self.assertEqual(self.relay.deliverable(1002), [])
        self.assertEqual(self.relay.db.execute("SELECT COUNT(*) FROM updates").fetchone()[0], 0)


class WebCommandQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        handle = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        handle.close()
        self.path = handle.name
        self.relay = Relay(self.path)

    def tearDown(self) -> None:
        self.relay.db.close()
        os.unlink(self.path)

    def test_command_lifecycle_is_durable(self) -> None:
        created = self.relay.enqueue_command(42, "agent_stop", {"session_id": "abc"})
        pulled = self.relay.pull_commands()
        self.assertEqual([item["id"] for item in pulled], [created["id"]])
        self.assertEqual(self.relay.command_status(created["id"], 42)["status"], "running")
        self.assertTrue(self.relay.finish_command(created["id"], True, "stopped"))
        self.assertEqual(self.relay.command_status(created["id"], 42)["status"], "done")
        self.assertIsNone(self.relay.command_status(created["id"], 7))

    def test_command_validation_blocks_shell_shaped_input(self) -> None:
        clean, error = validate_web_command("torrent_seek", {"seconds": 10, "extra": "; rm -rf ~"})
        self.assertEqual(clean, {"seconds": 10.0})
        self.assertIsNone(error)
        clean, error = validate_web_command("torrent_shell", {"command": "rm -rf ~"})
        self.assertIsNone(clean)
        self.assertEqual(error, "unknown command")

    def test_magnet_and_provider_are_allowlisted(self) -> None:
        self.assertIsNotNone(validate_web_command(
            "torrent_add", {"magnet": "magnet:?xt=urn:btih:abc", "mode": "stream"}
        )[0])
        self.assertIsNotNone(validate_web_command(
            "agent_provider", {"session_id": "abc", "provider": "claude", "model": "opus"}
        )[0])
        self.assertIsNotNone(validate_web_command(
            "agent_provider", {"session_id": "abc", "provider": "anything"}
        )[1])
        self.assertIsNotNone(validate_web_command(
            "agent_provider", {"session_id": "abc", "provider": "claude", "model": "fake"}
        )[1])

if __name__ == "__main__":
    unittest.main()
