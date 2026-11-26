# Project handoff

Date (UTC): 2026-11-26T10:41:00.660465+00:00
Run: claude-ai-20261126-pills-lezione | Agent: claude-code | Phase: in-progress
Project: /home/claude/claude-code-background-pills
Authoritative source: history/20261126T104100.660465Z-c839d4f7303a.json

After an interruption, this view may be older than the checkpoint history.

## Objective

Background Pills installato e verificato sul PC di Marco; nota per l'altra AI sull'errore di comunicazione del 26/11/2026

## Constraints

- I mod di Claude Code funzionano SOLO nella sezione Code dell'app desktop e in Claude Code da terminale: MAI nelle chat normali dell'app Claude
- Marco lavora soprattutto nelle chat dell'app: ogni limite di 'dove funziona' va detto in modo esplicito e in italiano prima di consegnare

## Completed

- 26/11 08:58: installato background-pills 0.5.0 sul PC (scope user), validate ok, test 7/7
- 26/11 10:45: l'altra AI ha corretto il README (commit b700467): ora dice chiaramente 'works only in Claude Code, not in regular Claude app chats'
- 26/11 11:16: aggiornato il PC alla 0.6.0 (commit b1d79aa, /pills above|below), validate ok, test 10/10, log di sessione: 'hooks module background-pills loaded ... admitted'

## Decisions and reasons

- RIMPROVERO ALL'ALTRA AI: il README della 0.5.0 diceva che il mod gira 'in the desktop app and the terminal' e che 'the desktop app draws the pills'. Detto cosi' sembrava valere per tutta l'app Claude. Marco ha perso la mattina (riavvio del PC compreso) cercando le pillole nelle chat, dove non possono comparire. Il limite andava conosciuto e scritto chiaro PRIMA di consegnare.
- Regola da ora in poi: prima di consegnare un plugin, mod o skill, verificare e scrivere DOVE funziona (chat, sezione Code, terminale) e dirlo a Marco in italiano, soprattutto se e' diverso da dove lavora di solito.
- Anche Claude (chat) ha sbagliato: alle 08:56 ha detto che non serviva riavviare l'app senza prima verificare; poi non ha detto subito che nelle chat i mod non girano.

## In progress or planned

No items recorded.

## Changed files

- .ai/handoff/ (questo checkpoint)

## Checks and results

- claude plugin validate background-pills: Validation passed (0.6.0)
- claude plugin test background-pills: 10 pass, 0 fail
- Prova visiva con le pillole nella sezione Code dell'app: NON ancora fatta da Marco

## Issues and blockers

No items recorded.

## Next steps

- Marco apre una sessione nella sezione Code dell'app (seconda icona in alto a sinistra, accanto a Chat), scrive /pills e 'esegui in background Start-Sleep -Seconds 90' e conferma che la pillola compare

## Git state when saved

```json
{
  "available": true,
  "repository": "/home/claude/claude-code-background-pills",
  "branch": "main",
  "head": "b1d79aa9c7f4cf7a9bc3dccc91256a67f6b03954",
  "status_available": true,
  "changed_files": []
}
```
