# barra-lavori

Mod per Claude Code (app desktop, scheda Code, e terminale). Mentre qualcosa gira in
background nella sessione, mostra sopra la casella del messaggio **una riga di pillole**,
una per ogni lavoro:

- la pillola **si riempie di colore** man mano che il lavoro avanza, con la percentuale e il
  tempo che manca;
- un lavoro senza una fine nota (un agente, un comando mai visto prima) mostra un puntino
  che pulsa e il tempo che scorre;
- **passando sopra** una pillola col mouse compare il dettaglio sulla stessa riga: fase e
  agenti finiti di un workflow, cosa sta facendo un agente e i suoi token, da dove viene la
  durata di un comando;
- quando un lavoro finisce bene, la pillola diventa verde con ✓ per 2 secondi e poi sparisce;
- le pillole che non stanno nella riga si raccolgono in **+N** (passandoci sopra, i nomi).

Le pillole restano nell'ordine in cui i lavori sono partiti. Quando non gira niente la riga
non c'è.

## Da dove vengono i numeri

- **Workflow**: la percentuale conta le fasi finite più la parte di agenti finiti nella fase
  in corso. Non torna mai indietro e si ferma al 99% finché il workflow non è finito. Il tempo
  che manca (con `~`, è una stima) viene dalla durata delle volte precedenti dello stesso
  workflow, se c'è. Altrimenti viene dal ritmo tenuto finora: serve almeno il 10% fatto e 15
  secondi di lavoro.
- **Comandi**: il tempo è esatto (senza `~`) quando il comando dice da solo quanto aspetta
  (`Start-Sleep`, `sleep`, `timeout /t`). Altrimenti è una stima (con `~`) dalla durata delle
  volte precedenti dello stesso comando. La prima volta che gira un comando senza durata
  scritta si vede solo il tempo trascorso.
- Se un lavoro supera il tempo previsto, al posto del conto alla rovescia compare `+0:40`.
- Se un lavoro era già partito quando la mod l'ha visto, il tempo ha davanti `≥`.
- Le durate passate restano sul computer, nell'archivio della mod dentro la configurazione di
  Claude Code: gli ultimi 5 tempi per al massimo 80 comandi o workflow.

## Quando la riga è chiusa

Se chiudi la fascia (il segno `[-]` accanto), dopo 2-3 secondi la riga di stato sotto la
casella dice lo stesso in poche parole. Per esempio: `⏳ consegne 47% ~6:12 · npm test 72% ~0:16`.

## Spegnerla

- App desktop: pulsante **+** accanto alla casella del messaggio, poi **Plugins**, e
  disattiva `barra-lavori`.
- Da un terminale: `claude plugin disable barra-lavori@background-pills`. Per riaccenderla:
  `claude plugin enable barra-lavori@background-pills`.

Vale per le sessioni aperte dopo il cambio.
