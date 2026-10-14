// SPDX-License-Identifier: Apache-2.0
import * as wasm from "../../packages/protocol/wasm/confidence_protocol.js";
import module from "../../packages/protocol/wasm/confidence_protocol_bg.wasm";
import { installKernel } from "../../packages/protocol/src/index";

wasm.initSync({ module });
installKernel(wasm);
export async function initializeKernel(): Promise<void> {}
