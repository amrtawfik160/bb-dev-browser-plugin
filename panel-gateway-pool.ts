import { PANEL_GATEWAY_BIND_HOST } from "./contracts.js";
import type {
  PanelCapabilityStore,
  PanelCapabilityIssue,
} from "./panel-capability.js";
import {
  createPanelGateway,
  type PanelGateway,
  type PanelGatewayClock,
} from "./panel-gateway.js";

/**
 * The Panel Capability is single-use: it is redeemed in the first WebSocket
 * message rather than placed in a URL. A panel remount issues a fresh
 * capability on a new gateway. The prior gateway stays bound until the shared
 * Panel session makes the newer generation authoritative, so remount-after-
 * redeem succeeds without immediately killing the still-authoritative
 * connection.
 */

export type PanelGatewayPoolOptions = {
  capabilities: PanelCapabilityStore;
  bindHost?: string;
  clock?: PanelGatewayClock;
  gatewayFactory?: (options: {
    capabilities: PanelCapabilityStore;
    hostId: string;
    profileId: string;
    bindHost: string;
    clock?: PanelGatewayClock;
  }) => PanelGateway;
};

export type PanelGatewayBinding = {
  ownerSessionId: string;
  panelId: string;
  hostId: string;
  profileId: string;
};

export type PanelGatewayPanel = {
  gateway: PanelGateway;
  issued: PanelCapabilityIssue;
};

export function panelGatewayKey(binding: {
  hostId: string;
  profileId: string;
  panelId: string;
}) {
  return `${binding.hostId}\u0000${binding.profileId}\u0000${binding.panelId}`;
}

export function createPanelGatewayPool(options: PanelGatewayPoolOptions) {
  const capabilities = options.capabilities;
  const bindHost = options.bindHost ?? PANEL_GATEWAY_BIND_HOST;
  const gatewayFactory =
    options.gatewayFactory ??
    ((factoryOptions) =>
      createPanelGateway({
        capabilities: factoryOptions.capabilities,
        hostId: factoryOptions.hostId,
        profileId: factoryOptions.profileId,
        bindHost: factoryOptions.bindHost,
        clock: factoryOptions.clock ?? options.clock,
      }));
  const gateways = new Map<string, PanelGateway>();

  function retire(gateway: PanelGateway) {
    gateway.close();
  }

  function openPanel(binding: PanelGatewayBinding): PanelGatewayPanel {
    const key = panelGatewayKey(binding);
    const gateway = gatewayFactory({
      capabilities,
      hostId: binding.hostId,
      profileId: binding.profileId,
      bindHost,
      clock: options.clock,
    });
    gateways.set(key, gateway);
    const issued = capabilities.issue({
      ownerSessionId: binding.ownerSessionId,
      panelId: binding.panelId,
      hostId: binding.hostId,
      profileId: binding.profileId,
    });
    return { gateway, issued };
  }

  function gatewayFor(binding: PanelGatewayBinding): PanelGateway | undefined {
    return gateways.get(panelGatewayKey(binding));
  }

  function closePanel(binding: {
    hostId: string;
    profileId: string;
    panelId: string;
  }) {
    const key = panelGatewayKey(binding);
    const gateway = gateways.get(key);
    if (gateway === undefined) return;
    retire(gateway);
    gateways.delete(key);
  }

  function dispose() {
    for (const gateway of gateways.values()) retire(gateway);
    gateways.clear();
  }

  return {
    openPanel,
    gatewayFor,
    closePanel,
    dispose,
    get declaredBindHost() {
      return bindHost;
    },
  };
}

export type PanelGatewayPool = ReturnType<typeof createPanelGatewayPool>;
