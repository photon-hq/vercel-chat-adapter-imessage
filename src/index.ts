export { iMessageAdapter } from "./adapter";
export {
  type CreateiMessageAdapterOptions,
  deriveAddress,
  type iMessageAdapterConfig,
  type iMessageAdapterLocalConfig,
  type iMessageAdapterRemoteConfig,
} from "./config";
export {
  type IMessageMessageEffect,
  iMessageEffect,
  type iMessageEffectName,
  resolveEffect,
} from "./effects";
export { createiMessageAdapter } from "./factory";
export { iMessageFormatConverter } from "./markdown";
export type { IMessageClientEntry, iMessageThreadId } from "./types";
