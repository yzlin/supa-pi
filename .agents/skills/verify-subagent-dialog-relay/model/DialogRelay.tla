------------------------------ MODULE DialogRelay ------------------------------
(* Model of the subagent dialog relay (extensions/subagent/dialog-relay.ts) and
   the parent dialog FIFO (extensions/subagent/dialog-queue.ts).

   One step = one Node macrotask (an I/O callback, a key press, a signal abort)
   plus every microtask it schedules. Node runs all microtasks before the next
   I/O callback, so a dialog settling, the relay's show().then, and the FIFO
   opening the next dialog happen in one step.

   Each relayed request has its own child socket (relayDialogs `ask` calls
   createConnection per dialog). Sockets are ordered byte streams: c2p is
   child -> parent, p2c is parent -> child. "fin" is a half-close (end()). *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Req,                 \* relayed child dialog requests (one socket each)
  BugNoAbortOnClose,   \* mutant: parent socket "close" handler aborts nothing
  BugFifoNoHold,       \* mutant: FIFO opens the next dialog without waiting
  BugChildIgnoresClose \* mutant: child socket "close" does not deny

Own == "own"           \* one dialog the parent opens for itself (e.g. ask)

VARIABLES
  child,      \* [Req -> {"idle","waiting","settled"}]   ask() promise
  how,        \* [Req -> {"none","local","parent","deny"}] who settled it
  localOpen,  \* [Req -> BOOLEAN] child-pane copy on screen
  answered,   \* [Req -> BOOLEAN] child `answered` flag
  cW,         \* [Req -> BOOLEAN] child socket.writable
  cGotFin,    \* [Req -> BOOLEAN] child read the parent's end
  cClosed,    \* [Req -> BOOLEAN] child "close" handler ran
  c2p, p2c,   \* [Req -> Seq(msg)] in-flight bytes
  acc,        \* [Req -> {"no","yes","refused"}] server accepted the socket
  pW,         \* [Req -> BOOLEAN] parent socket.writable
  pGotFin,    \* [Req -> BOOLEAN] parent read the child's end
  pDestroyed, \* [Req -> BOOLEAN] relay close() destroyed the socket
  pClosed,    \* [Req -> BOOLEAN] parent "close" handler ran
  pend,       \* [Req -> BOOLEAN] parent `pending` map holds the controller
  open,       \* SUBSET (Req \cup {Own}) parent dialogs on screen
  dq,         \* Seq(Req \cup {Own}) parent FIFO, waiting for their turn
  own,        \* {"idle","asked","done"}
  ui,         \* parentUI() returns a UI
  stop,       \* relay `stop` signal aborted (tool abort or close())
  relayClosed,\* relay close(): listener closed, sockets destroyed
  alive       \* child Pi process is running

vars == <<child, how, localOpen, answered, cW, cGotFin, cClosed, c2p, p2c, acc,
          pW, pGotFin, pDestroyed, pClosed, pend, open, dq, own, ui, stop,
          relayClosed, alive>>

Remove(s, x) == SelectSeq(s, LAMBDA y : y # x)
InSeq(x, s) == \E i \in 1..Len(s) : s[i] = x

(* FIFO: after the open dialog settles, the next queued one opens
   (dialog-queue.ts: tail.then ... await result). *)
Advance(o, q) ==
  IF o = {} /\ q # <<>> THEN <<{Head(q)}, Tail(q)>> ELSE <<o, q>>

(* queueDialogs enqueue: opens at once when nothing holds the slot. *)
Enqueue(d) ==
  IF BugFifoNoHold \/ (open = {} /\ dq = <<>>)
    THEN /\ open' = open \cup {d} /\ dq' = dq
    ELSE /\ open' = open /\ dq' = Append(dq, d)

(* Abort the parent dialog signal for the requests in S. Pi's showExtension*
   onAbort closes an open dialog; dialog-queue onAbort resolves a queued one,
   which is then skipped (`if (signal?.aborted) return`). *)
AbortDialogs(S) ==
  LET o == open \ S
      q == SelectSeq(dq, LAMBDA y : y \notin S)
      n == Advance(o, q)
  IN /\ open' = n[1] /\ dq' = n[2]

ParentCopy(r) == r \in open \/ InSeq(r, dq)

-----------------------------------------------------------------------------
Init ==
  /\ child = [r \in Req |-> "idle"]
  /\ how = [r \in Req |-> "none"]
  /\ localOpen = [r \in Req |-> FALSE]
  /\ answered = [r \in Req |-> FALSE]
  /\ cW = [r \in Req |-> FALSE]
  /\ cGotFin = [r \in Req |-> FALSE]
  /\ cClosed = [r \in Req |-> FALSE]
  /\ c2p = [r \in Req |-> <<>>]
  /\ p2c = [r \in Req |-> <<>>]
  /\ acc = [r \in Req |-> "no"]
  /\ pW = [r \in Req |-> FALSE]
  /\ pGotFin = [r \in Req |-> FALSE]
  /\ pDestroyed = [r \in Req |-> FALSE]
  /\ pClosed = [r \in Req |-> FALSE]
  /\ pend = [r \in Req |-> FALSE]
  /\ open = {}
  /\ dq = <<>>
  /\ own = "idle"
  /\ ui \in BOOLEAN
  /\ stop = FALSE
  /\ relayClosed = FALSE
  /\ alive = TRUE

-----------------------------------------------------------------------------
(* Child side: relayDialogs `ask` and its `finish`. *)

(* finish(value): settle once, abort the local copy, write cancel unless
   answered, then socket.end(). `ans` is the answered flag after this step. *)
Finish(r, by, ans) ==
  IF child[r] = "waiting"
    THEN /\ child' = [child EXCEPT ![r] = "settled"]
         /\ how' = [how EXCEPT ![r] = by]
         /\ localOpen' = [localOpen EXCEPT ![r] = FALSE]
         /\ c2p' = [c2p EXCEPT ![r] =
                      IF cW[r]
                        THEN (IF ans THEN @ ELSE Append(@, "cancel")) \o <<"fin">>
                        ELSE @]
         /\ cW' = [cW EXCEPT ![r] = FALSE]
    ELSE UNCHANGED <<child, how, localOpen, c2p, cW>>

(* ask(): write the request before connect, show the local copy. *)
ChildAsks(r) ==
  /\ alive /\ child[r] = "idle"
  /\ child' = [child EXCEPT ![r] = "waiting"]
  /\ localOpen' = [localOpen EXCEPT ![r] = TRUE]
  /\ cW' = [cW EXCEPT ![r] = TRUE]
  /\ c2p' = [c2p EXCEPT ![r] = <<"dialog">>]
  /\ UNCHANGED <<how, answered, cGotFin, cClosed, p2c, acc, pW, pGotFin,
                 pDestroyed, pClosed, pend, open, dq, own, ui, stop,
                 relayClosed, alive>>

(* The user answers the child-pane copy: local(signal).then(finish). *)
ChildUserAnswers(r) ==
  /\ alive /\ localOpen[r]
  /\ Finish(r, "local", answered[r])
  /\ UNCHANGED <<answered, cGotFin, cClosed, p2c, acc, pW, pGotFin, pDestroyed,
                 pClosed, pend, open, dq, own, ui, stop, relayClosed, alive>>

(* The caller's opts.signal aborts: onAbort -> finish(deny). *)
ChildCallerAborts(r) ==
  /\ alive /\ child[r] = "waiting"
  /\ Finish(r, "deny", answered[r])
  /\ UNCHANGED <<answered, cGotFin, cClosed, p2c, acc, pW, pGotFin, pDestroyed,
                 pClosed, pend, open, dq, own, ui, stop, relayClosed, alive>>

(* lineReader on the child socket. *)
ChildReads(r) ==
  /\ alive /\ ~cClosed[r] /\ p2c[r] # <<>>
  /\ p2c' = [p2c EXCEPT ![r] = Tail(@)]
  /\ LET m == Head(p2c[r]) IN
     IF m = "fin"
       THEN \* allowHalfOpen=false: Node ends our side too, no cancel.
            /\ cGotFin' = [cGotFin EXCEPT ![r] = TRUE]
            /\ c2p' = [c2p EXCEPT ![r] = IF cW[r] THEN Append(@, "fin") ELSE @]
            /\ cW' = [cW EXCEPT ![r] = FALSE]
            /\ UNCHANGED <<child, how, localOpen, answered>>
       ELSE \* "answer" or "unavail" (unavailable: true): answered = true; finish
            /\ answered' = [answered EXCEPT ![r] = TRUE]
            /\ Finish(r, IF m = "answer" THEN "parent" ELSE "deny", TRUE)
            /\ UNCHANGED cGotFin
  /\ UNCHANGED <<cClosed, acc, pW, pGotFin, pDestroyed, pClosed, pend, open, dq,
                 own, ui, stop, relayClosed, alive>>

(* Child socket "close": both ends done, or the connect was refused. *)
ChildSocketCloses(r) ==
  /\ alive /\ ~cClosed[r] /\ child[r] # "idle"
  /\ (cGotFin[r] /\ ~cW[r]) \/ acc[r] = "refused"
  /\ cClosed' = [cClosed EXCEPT ![r] = TRUE]
  /\ IF BugChildIgnoresClose
       THEN UNCHANGED <<child, how, localOpen, c2p, cW>>
       ELSE Finish(r, "deny", answered[r])
  /\ UNCHANGED <<answered, cGotFin, p2c, acc, pW, pGotFin, pDestroyed, pClosed,
                 pend, open, dq, own, ui, stop, relayClosed, alive>>

(* The child process exits or is killed: the kernel ends its sockets. *)
ChildDies ==
  /\ alive
  /\ alive' = FALSE
  /\ c2p' = [r \in Req |-> IF cW[r] THEN Append(c2p[r], "fin") ELSE c2p[r]]
  /\ cW' = [r \in Req |-> FALSE]
  /\ localOpen' = [r \in Req |-> FALSE]
  /\ UNCHANGED <<child, how, answered, cGotFin, cClosed, p2c, acc, pW, pGotFin,
                 pDestroyed, pClosed, pend, open, dq, own, ui, stop, relayClosed>>

-----------------------------------------------------------------------------
(* Parent side: startDialogRelay. *)

Accept(r) ==
  /\ acc[r] = "no" /\ child[r] # "idle" /\ ~relayClosed
  /\ acc' = [acc EXCEPT ![r] = "yes"]
  /\ pW' = [pW EXCEPT ![r] = TRUE]
  /\ UNCHANGED <<child, how, localOpen, answered, cW, cGotFin, cClosed, c2p,
                 p2c, pGotFin, pDestroyed, pClosed, pend, open, dq, own, ui,
                 stop, relayClosed, alive>>

(* server.close() stopped listening first: the connect fails. *)
Refuse(r) ==
  /\ acc[r] = "no" /\ child[r] # "idle" /\ relayClosed
  /\ acc' = [acc EXCEPT ![r] = "refused"]
  /\ c2p' = [c2p EXCEPT ![r] = <<>>]
  /\ cW' = [cW EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<child, how, localOpen, answered, cGotFin, cClosed, p2c, pW,
                 pGotFin, pDestroyed, pClosed, pend, open, dq, own, ui, stop,
                 relayClosed, alive>>

Send(r, m) == p2c' = [p2c EXCEPT ![r] = IF pW[r] THEN Append(@, m) ELSE @]

(* lineReader on the parent socket. *)
ParentReads(r) ==
  /\ acc[r] = "yes" /\ ~pDestroyed[r] /\ ~pGotFin[r] /\ c2p[r] # <<>>
  /\ c2p' = [c2p EXCEPT ![r] = Tail(@)]
  /\ LET m == Head(c2p[r]) IN
     CASE m = "dialog" ->
            IF ~ui \/ stop
              THEN /\ Send(r, "unavail")
                   /\ UNCHANGED <<pend, open, dq, pW, pGotFin>>
              ELSE /\ pend' = [pend EXCEPT ![r] = TRUE]
                   /\ Enqueue(r)
                   /\ UNCHANGED <<p2c, pW, pGotFin>>
       [] m = "cancel" ->
            \* pending.get(id)?.abort(); pending.delete(id); .then sends nothing
            /\ IF pend[r] THEN AbortDialogs({r}) ELSE UNCHANGED <<open, dq>>
            /\ pend' = [pend EXCEPT ![r] = FALSE]
            /\ UNCHANGED <<p2c, pW, pGotFin>>
       [] m = "fin" ->
            \* allowHalfOpen=false: Node ends the parent side too.
            /\ pGotFin' = [pGotFin EXCEPT ![r] = TRUE]
            /\ Send(r, "fin")
            /\ pW' = [pW EXCEPT ![r] = FALSE]
            /\ UNCHANGED <<pend, open, dq>>
  /\ UNCHANGED <<child, how, localOpen, answered, cW, cGotFin, cClosed, acc,
                 pDestroyed, pClosed, own, ui, stop, relayClosed, alive>>

(* Parent socket "close": abort every pending controller, clear the map. *)
ParentSocketCloses(r) ==
  /\ acc[r] = "yes" /\ ~pClosed[r]
  /\ (pGotFin[r] /\ ~pW[r]) \/ pDestroyed[r]
  /\ pClosed' = [pClosed EXCEPT ![r] = TRUE]
  /\ IF BugNoAbortOnClose
       THEN UNCHANGED <<open, dq>>
       ELSE IF pend[r] THEN AbortDialogs({r}) ELSE UNCHANGED <<open, dq>>
  /\ pend' = [pend EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<child, how, localOpen, answered, cW, cGotFin, cClosed, c2p,
                 p2c, acc, pW, pGotFin, pDestroyed, own, ui, stop, relayClosed,
                 alive>>

(* The user answers the parent copy: show() resolves, .then sends the value. *)
ParentUserAnswers(r) ==
  /\ r \in open
  /\ LET n == Advance(open \ {r}, dq) IN open' = n[1] /\ dq' = n[2]
  /\ IF pend[r] THEN Send(r, "answer") ELSE UNCHANGED p2c
  /\ pend' = [pend EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<child, how, localOpen, answered, cW, cGotFin, cClosed, c2p,
                 acc, pW, pGotFin, pDestroyed, pClosed, own, ui, stop,
                 relayClosed, alive>>

(* Tool abort (options.signal): stop aborts every pending dialog signal; each
   .then still finds its controller and sends the deny. *)
ToolAborts ==
  /\ ~stop
  /\ stop' = TRUE
  /\ LET S == {r \in Req : pend[r]} IN
     /\ AbortDialogs(S)
     /\ p2c' = [r \in Req |-> IF r \in S /\ pW[r]
                                THEN Append(p2c[r], "unavail") ELSE p2c[r]]
  /\ pend' = [r \in Req |-> FALSE]
  /\ UNCHANGED <<child, how, localOpen, answered, cW, cGotFin, cClosed, c2p,
                 acc, pW, pGotFin, pDestroyed, pClosed, own, ui, relayClosed,
                 alive>>

(* relay.close() in the runner's finally: closed.abort() fires the dialog
   aborts, then every socket is destroyed before the .then microtasks run, so
   their deny writes find socket.writable false. *)
RelayCloses ==
  /\ ~relayClosed
  /\ relayClosed' = TRUE
  /\ stop' = TRUE
  /\ AbortDialogs({r \in Req : pend[r]})
  /\ pend' = [r \in Req |-> FALSE]
  /\ pDestroyed' = [r \in Req |-> pDestroyed[r] \/ acc[r] = "yes"]
  /\ p2c' = [r \in Req |-> IF acc[r] = "yes" /\ pW[r]
                             THEN Append(p2c[r], "fin") ELSE p2c[r]]
  /\ pW' = [r \in Req |-> IF acc[r] = "yes" THEN FALSE ELSE pW[r]]
  /\ UNCHANGED <<child, how, localOpen, answered, cW, cGotFin, cClosed, c2p,
                 acc, pGotFin, pClosed, own, ui, alive>>

(* The parent's own dialog shares the FIFO. *)
ParentAsksOwn ==
  /\ own = "idle"
  /\ own' = "asked"
  /\ Enqueue(Own)
  /\ UNCHANGED <<child, how, localOpen, answered, cW, cGotFin, cClosed, c2p,
                 p2c, acc, pW, pGotFin, pDestroyed, pClosed, pend, ui, stop,
                 relayClosed, alive>>

ParentAnswersOwn ==
  /\ Own \in open
  /\ own' = "done"
  /\ LET n == Advance(open \ {Own}, dq) IN open' = n[1] /\ dq' = n[2]
  /\ UNCHANGED <<child, how, localOpen, answered, cW, cGotFin, cClosed, c2p,
                 p2c, acc, pW, pGotFin, pDestroyed, pClosed, pend, ui, stop,
                 relayClosed, alive>>

-----------------------------------------------------------------------------
Transport(r) ==
  Accept(r) \/ Refuse(r) \/ ParentReads(r) \/ ParentSocketCloses(r)
  \/ ChildReads(r) \/ ChildSocketCloses(r)

Next ==
  \/ \E r \in Req :
       \/ ChildAsks(r) \/ ChildUserAnswers(r) \/ ChildCallerAborts(r)
       \/ ParentUserAnswers(r) \/ Transport(r)
  \/ ChildDies \/ ToolAborts \/ RelayCloses
  \/ ParentAsksOwn \/ ParentAnswersOwn

(* Sockets and Node handlers make progress; people, aborts and crashes may
   never happen. *)
Spec == Init /\ [][Next]_vars /\ \A r \in Req : WF_vars(Transport(r))

-----------------------------------------------------------------------------
TypeOK ==
  /\ child \in [Req -> {"idle", "waiting", "settled"}]
  /\ open \subseteq Req \cup {Own}
  /\ \A r \in Req : Len(c2p[r]) <= 3 /\ Len(p2c[r]) <= 3

(* The parent shows one non-overlay dialog at a time (dialog-queue.ts). *)
OneParentDialog == Cardinality(open) <= 1

(* After the parent socket closes, no copy of its dialog is shown or queued. *)
NoCopyAfterClose == \A r \in Req : pClosed[r] => ~ParentCopy(r)

(* A child answer from the parent is an answer the user gave in the parent. *)
StoppedWaiting(r) == child[r] = "settled" \/ (~alive /\ child[r] # "idle")

(* Once the child stops waiting, the parent copy goes away for good without
   anyone answering it. *)
ParentCopyGoesAway == \A r \in Req : StoppedWaiting(r) ~> []~ParentCopy(r)

(* A child never waits on a dialog the parent cannot show (README "Child
   relay": no UI, aborting, or relay gone). *)
NeverWaitsOnUnanswerable ==
  \A r \in Req :
    (alive /\ child[r] = "waiting" /\ (~ui \/ stop)) ~> (child[r] = "settled" \/ ~alive)
=============================================================================
