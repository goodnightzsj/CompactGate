export const encryptedAgentMessage = {
  type: "agent_message",
  id: "amsg_synthetic",
  author: "agent_synthetic",
  recipient: "all",
  content: [
    { type: "input_text", text: "The delegated task is complete." },
    { type: "encrypted_content", encrypted_content: "opaque-agent-state" }
  ],
  internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn", create_time: 1 }
};

export const encryptedAgentError = { error: {
  code: "invalid_encrypted_content",
  message: "The encrypted content for item amsg_synthetic could not be verified. " +
    "Reason: encrypted content hydration failed: Encrypted content could not be decrypted or parsed.",
  type: "invalid_request_error"
} };
