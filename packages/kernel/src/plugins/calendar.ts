import { hashCalendarProviderIdentifier } from "@odinn/protocol";
import { listCalendarEvents, listCalendars, readCalendarEvent } from "../calendar.ts";
import { validatePluginManifest, type PluginManifest } from "../plugin-contracts.ts";
import { liveOnlyProviderInputSchema } from "../live-only-provider-contracts.ts";
import type { HostCapabilityPlugin, HostCapabilityPluginContext, HostCapabilityTool } from "./host-capability.ts";

const calendarReadManifest = {
  schemaVersion: 1,
  id: "calendar-read",
  version: "0.1.0",
  kind: "host-capability",
  runtime: "host-adapter",
  displayName: "Calendar read access",
  activation: { enabledByDefault: false },
  tools: [
    {
      name: "calendar.calendars",
      description: "List bounded calendar metadata for one explicitly selected account.",
      capabilities: ["calendar.read", "network.access", "secret.reference.use"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: ["providerDigest", "generationDigest", "accountDigest"],
      modelVisible: true
    },
    {
      name: "calendar.events",
      description: "List a bounded time window from one explicitly selected calendar.",
      capabilities: ["calendar.read", "network.access", "secret.reference.use"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: ["providerDigest", "generationDigest", "accountDigest", "calendarDigest"],
      modelVisible: true
    },
    {
      name: "calendar.read",
      description: "Read one event from one explicitly selected calendar.",
      capabilities: ["calendar.read", "network.access", "secret.reference.use"],
      safety: { effects: ["read", "network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false },
      resourceFields: ["providerDigest", "generationDigest", "accountDigest", "calendarDigest", "eventDigest"],
      modelVisible: true
    }
  ]
} as const;

export const CALENDAR_READ_PLUGIN_MANIFEST: PluginManifest = validatePluginManifest(calendarReadManifest);

export const calendarReadHostCapabilityPlugin: HostCapabilityPlugin = {
  manifest: CALENDAR_READ_PLUGIN_MANIFEST,
  createTools: (pluginContext: HostCapabilityPluginContext): ReadonlyMap<string, HostCapabilityTool> => {
    const provider = pluginContext.calendarReadProvider;
    if (!provider) throw new Error("calendar read plugin requires a configured provider");
    const targetResource = () => Object.freeze({
      providerDigest: hashCalendarProviderIdentifier(provider.target.providerId, "calendar provider target.providerId", 128),
      generationDigest: hashCalendarProviderIdentifier(provider.target.generation, "calendar provider target.generation", 128)
    });
    const accountResource = (input: Record<string, unknown>) => Object.freeze({
      ...targetResource(),
      accountDigest: hashCalendarProviderIdentifier(input.accountId, "calendar resource accountId")
    });
    const calendarResource = (input: Record<string, unknown>) => Object.freeze({
      ...accountResource(input),
      calendarDigest: hashCalendarProviderIdentifier(input.calendarId, "calendar resource calendarId")
    });
    return new Map([
      ["calendar.calendars", {
        capability: "calendar.read",
        description: "List bounded calendar metadata for one explicitly selected account.",
        inputSchema: liveOnlyProviderInputSchema("calendar.calendars"),
        resourceForInput: accountResource,
        execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => listCalendars(provider, input, context.signal)
      }],
      ["calendar.events", {
        capability: "calendar.read",
        description: "List a bounded time window from one explicitly selected calendar.",
        inputSchema: liveOnlyProviderInputSchema("calendar.events"),
        resourceForInput: calendarResource,
        execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => listCalendarEvents(provider, input, context.signal)
      }],
      ["calendar.read", {
        capability: "calendar.read",
        description: "Read one event from one explicitly selected calendar.",
        inputSchema: liveOnlyProviderInputSchema("calendar.read"),
        resourceForInput: (input: Record<string, unknown>) => Object.freeze({
          ...calendarResource(input),
          eventDigest: hashCalendarProviderIdentifier(input.eventId, "calendar resource eventId")
        }),
        execute: async (input: Record<string, unknown>, context: Record<string, any> = {}) => readCalendarEvent(provider, input, context.signal)
      }]
    ]);
  }
};
