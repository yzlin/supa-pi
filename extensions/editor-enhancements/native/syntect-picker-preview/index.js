const { existsSync } = require("node:fs");
const { join } = require("node:path");

const bindingNames = {
  darwin: {
    arm64: "syntect-picker-preview.darwin-arm64.node",
    x64: "syntect-picker-preview.darwin-x64.node",
  },
  linux: {
    arm64: "syntect-picker-preview.linux-arm64.node",
    x64: "syntect-picker-preview.linux-x64.node",
  },
};

let attempted = false;
let nativeBinding = null;
let loadError = null;

function resolveBindingName() {
  const platformBindings = bindingNames[process.platform];
  if (!platformBindings) return null;
  return platformBindings[process.arch] ?? null;
}

function tryLoadNativeBinding() {
  if (attempted) {
    return nativeBinding;
  }

  attempted = true;
  const bindingName = resolveBindingName();
  if (!bindingName) {
    return null;
  }

  const bindingPath = join(__dirname, bindingName);
  if (!existsSync(bindingPath)) {
    return null;
  }

  try {
    nativeBinding = require(bindingPath);
  } catch (error) {
    loadError = error;
    nativeBinding = null;
  }

  return nativeBinding;
}

function getNativeBinding() {
  return tryLoadNativeBinding();
}

function getNativeBindingStatus() {
  tryLoadNativeBinding();
  return {
    attempted,
    error: loadError,
    loaded: nativeBinding !== null,
  };
}

module.exports = {
  getNativeBinding,
  getNativeBindingStatus,
};