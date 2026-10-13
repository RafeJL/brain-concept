How to write each kind of page:
- Open every page, after its heading, with one cited sentence saying what it covers. It is shown on its own in the wiki's index.
- An area page: what the part is for, its main pieces and how a request or job moves through them, what it depends on, and where a developer would make a typical change.
- A flow page: the journey as numbered steps, from the trigger to the outcome, each step saying where it happens and citing it. Where a step crosses into another area or service, say how (the endpoint, event or call), and name the other side's page.
- The data-model page (slug "data-model"): the main entities, their key fields and relations, and where each is stored (the table, collection or file), citing the class and the migration or mapping that defines it.
- The integrations page (slug "integrations"): each outside system (a database, a message broker, an identity provider, a third-party API), what it is used for, how it is called and where it is configured.
Diagrams: the overview has one Mermaid `flowchart` of the main parts and how they connect, and each flow page has one Mermaid `sequenceDiagram` of its steps. No other page has diagrams. Inside a ```mermaid block, cite the code in a comment line just above each box, labelled link and message, for example:
%% [src/Ordering.API/Program.cs:12-20]
ordering["Ordering API"]
Label boxes and messages with names that appear in the cited lines. Each is checked like a sentence and removed if it fails, and a diagram that mostly fails is dropped, so keep diagrams small: at most 12 boxes or messages.
