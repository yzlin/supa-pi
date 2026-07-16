/* Local unified-edit public schema. */
import { type Static, Type } from "typebox";

export const unifiedEditSchema = Type.Object(
  {
    text: Type.String({
      description:
        "Local unified-edit dialect: [path] row operations or a Codex *** Begin Patch payload.",
    }),
  },
  { additionalProperties: false }
);

export type UnifiedEditParameters = Static<typeof unifiedEditSchema>;
