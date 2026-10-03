# Use hybrid owner-gated streaming

Automation Mode uses an adaptive 5–15 FPS CDP-backed canvas stream up to 1920×1080, while Safe Login Mode uses an X display and VNC stream so the browser can run without an automation attachment; v1 deliberately omits audio and DRM/media-fidelity guarantees. The host gateway chooses a loopback port per retained worker generation and reaches web/PWA and desktop Browser Panels through a required BB Connect enrollment and owner-session gate. A single-use 60-second Panel Capability, bound to owner session, panel, host, and profile, is redeemed in the first WebSocket message rather than a URL and then authorizes a connection that rotates every five minutes. Messages and input rates are validated and bounded, panel bandwidth is capped, and congestion drops stale video frames before delaying input; Chrome, CDP, and VNC are never exposed directly. Mobile remains unsupported while BB mobile does not mount plugin frontends.

Small Browser Panels capture at up to twice their logical viewport density,
within the same 1920×1080 physical pixel cap. JPEG frames use quality 95 and
the canvas retains their physical pixels; input uses the logical viewport.
The owner controller can explicitly download a PNG of the selected Browser
Tab's viewport or full page through the authenticated panel connection.
Screenshots are bounded to 64 million pixels and 32 MiB, travel in bounded
chunks under the panel bandwidth cap, and are never retained by the plugin.

While page input has focus, keyboard shortcuts belong to the controlled page
and cannot bubble into BB's panel-close or panel-toggle commands. Native paste
and composition still deliver text once. Shift+Escape releases page input;
BB shortcuts remain available after focus moves outside the page surface.
