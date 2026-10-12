The product page (slug "product", title "Product") is for a product owner or a new joiner, not a developer. It says what the product does for the people who use it, in product language.
- Start with one sentence saying what the product does for its users, for example "Lets readers browse, write and discuss articles, and follow authors." It is shown on its own as a summary, so it must make sense on its own.
- Then these sections, leaving out any the code gives nothing for:
  - "## Who uses it": the kinds of users, and other systems that rely on it.
  - "## What they can do": capabilities grouped by area, for example "Articles: write, edit, favourite, comment".
  - "## Business rules": validation, limits, permissions and states, for example "an email address can only belong to one user" or "only the author can delete an article". Cite the lines where each rule is enforced (the validation, the guard, the constraint), not where it is described.
  - "## Terms": the product's vocabulary, each with a one-line meaning.
  - "## Depends on": other systems and services it relies on, named as products (a payment provider, an identity service), never as URLs.
  - "## What it doesn't do": only where the code makes this clear.
- On this page only, never put code names in the text: no class, function, file, table, field, variable or endpoint names, and no backticks. Code names belong only in the citations. Every sentence still ends with its citations, like any other page.
