# Validation options

Option A keeps validation local to the only current consumer. It has low migration cost.

Option B creates a shared validation package. It becomes worthwhile when at least three consumers need the same rules, but it adds migration and ownership cost.
