### 11. AI / LLM Security

Treat model output like any other untrusted input. Prompts are not a security boundary.

#### ❌ NEVER Trust Model Output Directly
```typescript
const sql = await model.generate(`Write SQL for: ${userQuestion}`)
await db.query(sql) // arbitrary query execution

const html = await model.generate(userPrompt)
element.innerHTML = html // XSS risk
```

#### ✅ Validate and Constrain Model Output
```typescript
const raw = await model.generateObject({ prompt: userPrompt, schema: ActionSchema })
const action = ActionSchema.parse(raw)

await runAllowlistedAction(action.name, action.args)
```

#### Verification Steps
- [ ] Model output validated before use
- [ ] No raw model output passed to SQL, shell, `eval`, HTML, file paths, or tool calls
- [ ] Secrets, cross-tenant data, and privileged system prompts kept out of model context
- [ ] Tool permissions scoped to the minimum required
- [ ] Destructive or irreversible tool actions require confirmation
- [ ] Token, loop, and request limits prevent unbounded consumption
