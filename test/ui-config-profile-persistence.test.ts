import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyForm } from "../src/ui/config/config-form-state.js";
import { createConfigProfilePersistenceActions } from "../src/ui/hooks/configProfilePersistenceActions.js";
import type { PublicConfig } from "../src/shared/types.js";

describe("config profile persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves an explicit mapped draft instead of the form captured by the action", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(createdClaudeProfile()), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { setTimeout: vi.fn() });

    const currentForm = {
      ...emptyForm(),
      claudePrimaryBaseUrl: "https://old.example",
      claudePrimaryUpstreamProtocol: "anthropic_messages" as const
    };
    const mappedForm = {
      ...currentForm,
      claudePrimaryBaseUrl: "https://mapped.example/v1",
      claudePrimaryApiKey: "target-draft-key",
      claudePrimaryUpstreamProtocol: "openai_responses" as const,
      claudeCompactBaseUrl: "https://mapped-compact.example/v1",
      claudeCompactUpstreamProtocol: "openai_chat" as const,
      claudeCompactUpstreamMode: "split" as const
    };
    const accessors = {
      name: "",
      selectedId: "",
      state: "idle" as const,
      setName: vi.fn(),
      setSelectedId: vi.fn(),
      setState: vi.fn(),
      setError: vi.fn()
    };
    const actions = createConfigProfilePersistenceActions({
      config: null,
      form: currentForm,
      setConfig: vi.fn(),
      setForm: vi.fn(),
      setHealth: vi.fn(),
      setSaveError: vi.fn(),
      setSaveState: vi.fn(),
      scopedProfileAccessors: () => accessors
    });

    await expect(actions.saveConfigProfile("claude", "Mapped", mappedForm)).resolves.toBe(true);
    const request = fetchMock.mock.calls[0]?.[1];
    const payload = JSON.parse(String(request?.body));

    expect(payload).toMatchObject({
      scope: "claude",
      name: "Mapped",
      config: {
        claude: {
          primary: {
            base_url: "https://mapped.example/v1",
            api_key: "target-draft-key",
            upstream_protocol: "openai_responses"
          },
          compact: {
            base_url: "https://mapped-compact.example/v1",
            upstream_protocol: "openai_chat",
            upstream_mode: "split"
          }
        }
      }
    });
  });
});

function createdClaudeProfile(): PublicConfig {
  return {
    profile_scopes: {
      codex: { profiles: [], active_profile_id: null },
      claude: {
        profiles: [{ id: "created", name: "Mapped" }],
        active_profile_id: null
      }
    }
  } as unknown as PublicConfig;
}
