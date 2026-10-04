# Add a task

A user adds a task from the home form or the quick-add page. The task must
appear in the list and be stored; a final list screen alone does not prove it
was saved.

```json
{
  "id": "add-task",
  "title": "Add a task",
  "entryPoints": [
    { "id": "home-form", "route": "/", "handles": ["form#add-task", "input[name=title]"] },
    { "id": "quick-add", "route": "/quick-add", "handles": ["form#quick-add", "input[name=title]"] }
  ],
  "subFeatures": ["blank title refusal"],
  "userRoute": ["open the entry point", "type a title", "submit the form", "open /tasks"],
  "observableEndState": "the title is listed at /tasks and read back from the store",
  "storedValues": ["task title"],
  "gotchas": ["a blank title is refused with 422 on purpose", "the list renders from memory, so read the store separately"]
}
```
