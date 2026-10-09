// Stands in for chrome-devtools-mcp: records the arguments the axi bridge gives
// it, then starts the real one. chrome-devtools-mcp renames its process, which
// hides those arguments from /proc.
import "./record-mcp-argv.mjs";
import "../../vendor/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js";
