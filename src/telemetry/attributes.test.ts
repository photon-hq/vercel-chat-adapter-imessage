import { describe, expect, it } from "vitest";

import {
  buildCommonAttributes,
  redactChatGuid,
  redactThreadId,
} from "./attributes";

describe("redactChatGuid", () => {
  it("redacts phone numbers in chat GUIDs", () => {
    expect(redactChatGuid("iMessage;-;+15551234567")).toBe(
      "iMessage;-;+1555***4567",
    );
  });

  it("leaves group chat GUIDs unchanged (no phone number)", () => {
    const groupGuid = "iMessage;+;chat123456789";
    expect(redactChatGuid(groupGuid)).toBe(groupGuid);
  });
});

describe("redactThreadId", () => {
  it("strips imessage: prefix, redacts, then re-adds prefix", () => {
    expect(redactThreadId("imessage:iMessage;-;+15551234567")).toBe(
      "imessage:iMessage;-;+1555***4567",
    );
  });

  it("falls through to redactChatGuid when there is no imessage: prefix", () => {
    expect(redactThreadId("iMessage;-;+15551234567")).toBe(
      "iMessage;-;+1555***4567",
    );
  });
});

describe("buildCommonAttributes", () => {
  it("redacts thread ids when PII redaction is enabled", () => {
    const attrs = buildCommonAttributes("remote", {
      chatGuid: "iMessage;-;+15551234567",
      threadId: "imessage:iMessage;-;+15551234567",
      redactPII: true,
    });

    expect(attrs["imessage.chat_guid"]).toBe("iMessage;-;+1555***4567");
    expect(attrs["imessage.thread_id"]).toBe(
      "imessage:iMessage;-;+1555***4567",
    );
  });

  it("preserves raw thread ids when PII redaction is disabled", () => {
    const attrs = buildCommonAttributes("remote", {
      threadId: "imessage:iMessage;-;+15551234567",
      redactPII: false,
    });

    expect(attrs["imessage.thread_id"]).toBe(
      "imessage:iMessage;-;+15551234567",
    );
  });

  it("includes service.name when provided", () => {
    const attrs = buildCommonAttributes("remote", {
      serviceName: "imessage-bot",
    });

    expect(attrs["service.name"]).toBe("imessage-bot");
  });

  it("returns only the mode attribute when no opts are provided", () => {
    const attrs = buildCommonAttributes("local");

    expect(attrs).toEqual({ "imessage.mode": "local" });
  });

  it("sets has_attachments to false when attachmentCount is 0", () => {
    const attrs = buildCommonAttributes("remote", { attachmentCount: 0 });

    expect(attrs["imessage.attachment_count"]).toBe(0);
    expect(attrs["imessage.has_attachments"]).toBe(false);
  });

  it("sets has_attachments to true when attachmentCount > 0", () => {
    const attrs = buildCommonAttributes("remote", { attachmentCount: 3 });

    expect(attrs["imessage.attachment_count"]).toBe(3);
    expect(attrs["imessage.has_attachments"]).toBe(true);
  });

  it("includes messageId in attributes when provided", () => {
    const attrs = buildCommonAttributes("local", {
      messageId: "msg-abc-123",
    });

    expect(attrs["imessage.message_id"]).toBe("msg-abc-123");
  });

  it("includes isGroupChat in attributes when provided", () => {
    const attrs = buildCommonAttributes("remote", { isGroupChat: true });
    expect(attrs["imessage.is_group_chat"]).toBe(true);

    const attrs2 = buildCommonAttributes("remote", { isGroupChat: false });
    expect(attrs2["imessage.is_group_chat"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adversarial / edge-case inputs (Task 8 – PII resilience)
// ---------------------------------------------------------------------------

describe("redactChatGuid adversarial inputs", () => {
  it("redacts UK phone numbers", () => {
    // +447911123456 has 12 digits: regex captures +4479, masks 111, captures 2345, trailing 6 remains
    expect(redactChatGuid("iMessage;-;+447911123456")).toBe(
      "iMessage;-;+4479***23456",
    );
  });

  it("leaves short phone numbers unchanged (no regex match)", () => {
    expect(redactChatGuid("iMessage;-;+1234")).toBe("iMessage;-;+1234");
  });

  it("is idempotent — double-redaction produces the same value", () => {
    const once = "iMessage;-;+1555***4567";
    // The regex needs \d{3} after the first 4 digits, but *** is not digits.
    expect(redactChatGuid(once)).toBe(once);
  });

  it("returns empty string unchanged", () => {
    expect(redactChatGuid("")).toBe("");
  });

  it("redacts the first phone pattern in a multi-phone GUID", () => {
    const input = "iMessage;+;+15551234567;+15559876543";
    const result = redactChatGuid(input);
    // First phone number should be redacted
    expect(result).toContain("+1555***4567");
  });
});

describe("redactThreadId adversarial inputs", () => {
  it("redacts a bare phone number with no imessage: prefix", () => {
    expect(redactThreadId("+15551234567")).toBe("+1555***4567");
  });

  it("handles empty imessage: prefix (nothing after it)", () => {
    expect(redactThreadId("imessage:")).toBe("imessage:");
  });

  it("handles nested imessage: prefix by only stripping the first one", () => {
    expect(redactThreadId("imessage:imessage:+15551234567")).toBe(
      "imessage:imessage:+1555***4567",
    );
  });
});

describe("buildCommonAttributes defensive inputs", () => {
  it("returns only imessage.mode when all optional fields are undefined", () => {
    const attrs = buildCommonAttributes("local", {
      serviceName: undefined,
      chatGuid: undefined,
      threadId: undefined,
      messageId: undefined,
      isGroupChat: undefined,
      attachmentCount: undefined,
      redactPII: undefined,
    });

    expect(attrs).toEqual({ "imessage.mode": "local" });
  });

  it("sets has_attachments to false and preserves NaN attachment_count", () => {
    const attrs = buildCommonAttributes("remote", { attachmentCount: NaN });

    // NaN > 0 is false in JS
    expect(attrs["imessage.has_attachments"]).toBe(false);
    expect(attrs["imessage.attachment_count"]).toBeNaN();
  });

  it("sets has_attachments to false for negative attachmentCount", () => {
    const attrs = buildCommonAttributes("remote", { attachmentCount: -1 });

    expect(attrs["imessage.has_attachments"]).toBe(false);
    expect(attrs["imessage.attachment_count"]).toBe(-1);
  });
});
