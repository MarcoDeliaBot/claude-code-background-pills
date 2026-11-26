# background-pills

A Claude Code mod: one row of pills above the message box, one pill for each piece of background
work in the session (workflows, background agents, background shell commands), shown only while
it runs.

> **Background Pills is a Claude Code mod. It works only in Claude Code: in the Code tab of the
> Claude desktop app (graphic pills) and in the terminal (text pills). It does not appear in
> regular Claude app chats. After installing, start a new session in the Code tab.**

- The pill fills as the work moves toward its end, with the percent and the time left: exact when
  a command states its wait, estimated (`~`) from earlier runs or from a workflow's pace otherwise.
- Work with no known end shows a breathing dot, a passing light and the time running.
- Pointing at a pill shows its detail on the same row.
- Work that ends well turns green with a ✓ for two seconds, then goes.
- Pills that do not fit the row are counted in `+N`.
- The row sits above the message box by default. `/pills below` moves it under the message box,
  where the app shows it as text with a small bar; `/pills above` brings it back. The choice is
  kept for new sessions.
- Background tasks that only wait, such as monitors and live updates, get no pill.

Pictures, install steps and details: see the [repository README](../README.md).

Turn it off: in the Code tab, **+** next to the message box → **Plugins** → turn off
`background-pills`, or
`claude plugin disable background-pills@background-pills`.
