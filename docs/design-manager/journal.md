# Design records

`openDesignJournal({root, userId, projectId, version})` stores ordinary SQLite records outside Git in a private directory.
Use `execute({command: 'append', kind, record})`, `execute({command: 'read'})`, or `execute({command: 'backup', destination})`.
The destination must be private. Backup refuses to overwrite an existing database.
Existing records, events, interview snapshots and artifact references remain readable under `existing`; existing artifact files are left in place.
SQLite backup copies all database tables. Preserve the original directory, including any existing artifact files, with your ordinary filesystem backup.
The journal no longer replays interviews, seals database identity, signs acceptance or administers artifacts.
