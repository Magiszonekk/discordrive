// Placeholder page of the skeleton: proves the window reaches the agent over the port from the preload.
// Replaced by the built web app once its core can run in the agent.
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || !e.data.ddnAgentPort) return;
  const port = e.ports[0];
  port.onmessage = (m) => {
    window.ddnSmoke = m.data;
    document.querySelector('[data-ddn="agent-status"]').textContent = m.data.ok ? "Agent: Node " + m.data.result.node : "Agent error";
  };
  port.postMessage({ id: 1, method: "ping", args: [] });
});
