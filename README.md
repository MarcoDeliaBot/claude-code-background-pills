# Claude Code background pills

A mod for [Claude Code](https://code.claude.com) (desktop app and terminal) that shows the
background work of a session as **one row of pills above the message box**, only while
something runs:

- **workflows** (the Workflow tool): the pill fills as phases and agents finish, with the
  percent and an estimated time left; pointing at it shows the phase and how many agents
  are done;
- **background shell commands**: an exact countdown when the command says how long it
  waits (`sleep`, `Start-Sleep`, `timeout /t`), an estimate (`~`) from earlier runs of the
  same command otherwise;
- **background agents**: a breathing dot and a passing light, the time running and, on
  hover, what the agent is doing and its tokens;
- a finished pill turns green with a ✓ for two seconds, then goes;
- pills that do not fit the row are counted in `+N`.

Nothing changes in how Claude works: the mod only watches what runs. The interface text is
in Italian.

## Install

In Claude Code:

```
/plugin marketplace add MarcoDeliaBot/claude-code-background-pills
/plugin install barra-lavori@background-pills
```

Then open a new session. Built and tested on Claude Code 2.1.330, which runs mods (hooks
modules).

## Turn it off

- Desktop app: **+** next to the message box → **Plugins** → turn off `barra-lavori`.
- Terminal: `claude plugin disable barra-lavori@background-pills`
  (`enable` to turn it back on).

## Where the numbers come from

- **Workflow percent**: phases done plus the share of agents done in the current phase;
  it never goes back and stops at 99% until the run ends. The time left comes from earlier
  runs of the same workflow, or from the pace so far (once 10% is done and 15 s have passed).
- **Commands**: exact when the command states its wait, estimated from earlier runs
  otherwise; the first run of an unknown command shows only the time running.
- Past durations stay on your computer, in the mod's own store under the Claude Code
  configuration folder: the last 5 times for at most 80 commands or workflows.
- With the band collapsed, the status line under the message box says the same in a few
  words.

## Develop

```
claude plugin validate barra-lavori
claude plugin test barra-lavori
```

## License

MIT

---

## In italiano

Mod per Claude Code (app desktop e terminale). Mentre qualcosa gira in background mostra
sopra la casella del messaggio **una riga di pillole**, una per ogni lavoro: workflow,
comandi in background e agenti. Ogni pillola si riempie man mano che il lavoro avanza, con
la percentuale e il tempo che manca. Passandoci sopra col mouse compare il dettaglio. Alla
fine diventa verde con ✓ e poi sparisce.

Installazione: i due comandi `/plugin` qui sopra, poi una sessione nuova.
Per spegnerla: **+** → **Plugins** → disattiva `barra-lavori`.
Dettagli in [barra-lavori/README.md](barra-lavori/README.md).
