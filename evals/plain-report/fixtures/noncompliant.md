## Result

In order to address the issue that was reported by the user regarding findings that are missing file paths in the review workflow output, a validation step was added to the schema and numerous related tests were updated accordingly.

We decided to utilize the existing schema helper. The check is run prior to synthesis. Subsequently, the verifier was updated to leverage it. Errors are shown to the user. Old findings were migrated. The cache was cleared.

## Steps

1. Commence the review by running the command on a branch that contains at least one change that the reviewers are able to inspect.
2. Check the result.
