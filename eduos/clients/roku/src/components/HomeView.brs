sub init()
    m.top.ObserveField("active", "onActive")
    m.header = m.top.findNode("header")
    m.who = m.top.findNode("who")
    m.menu = m.top.findNode("menu")
    m.items = m.top.findNode("items")
    m.detail = m.top.findNode("detail")
    m.pinEntry = m.top.findNode("pinEntry")
    m.panelTitle = m.top.findNode("panelTitle")
    m.panelNote = m.top.findNode("panelNote")
    m.menu.ObserveField("itemSelected", "onMenuSelected")
    m.menu.ObserveField("itemFocused", "noteActivity")
    m.items.ObserveField("itemSelected", "onItemSelected")
    m.items.ObserveField("itemFocused", "noteActivity")
    m.pinEntry.ObserveField("done", "onPinDone")
    m.photoViewer = m.top.findNode("photoViewer")
    m.photoViewer.ObserveField("closed", "onPhotosClosed")
    m.detailPhotos = []
    m.children = []
    m.section = ""
    m.mode = "list"
end sub

sub noteActivity()
    m.global.activityAt = CreateObject("roDateTime").AsSeconds()
end sub

sub onActive()
    if not m.top.active
        ApiCancelAll()
        return
    end if
    role = RegRead("role")
    m.header.text = "EduOS"
    m.who.text = RegRead("server").Replace("https://", "") + "  |  signed in as " + RoleText(role) + " (look-only)"
    m.children = []
    if role = "parent"
        m.menu.content = ListContent([{ title: "Loading..." }])
        ApiCall({ method: "GET", path: "/api/home" }, onHome)
    else
        buildMenu()
    end if
    m.menu.setFocus(true)
end sub

function RoleText(role as string) as string
    if role = "parent" then return "a parent"
    if role = "student" then return "a student"
    if role = "" then return "a district account"
    return role.Replace("_", " ")
end function

sub onHome(res as object, tag as string)
    if not handled(res)
        d = res.data.data
        if type(d) = "roAssociativeArray" and type(d.children) = "roArray"
            for each c in d.children
                m.children.Push({ id: Str2(c.id), name: Str2(c.display_name, "Your child") })
            end for
        end if
    end if
    buildMenu()
    print "EduOS: home "; tag
end sub

sub buildMenu()
    rows = [{ id: "capsules", title: "Time Capsules" }]
    role = RegRead("role")
    if role = "parent"
        for each c in m.children
            rows.Push({ id: "history:" + c.id, title: "History: " + c.name })
        end for
    else if role = "student"
        rows.Push({ id: "history:", title: "My history" })
    end if
    rows.Push({ id: "lock", title: "Screen lock" })
    rows.Push({ id: "signout", title: "Sign out of this TV" })
    m.menu.content = ListContent(rows)
    m.menu.jumpToItem = 0
    openSection("capsules")
end sub

' --- Responses shared by every list ---------------------------------------
' True when the response was a problem (and has been dealt with).
function handled(res as object) as boolean
    if res.status >= 200 and res.status < 300 and type(res.data) = "roAssociativeArray" then return false
    if res.status = 401
        ForgetSession()
        m.top.outcome = { go: "pair", note: "Your sign-in on this TV ended. Sign in again with a new code." }
    else if res.status = 403
        showNote("This account can't see that on a TV.")
    else if res.status = 404
        showNote("That isn't there any more.")
    else if res.status = 0
        showNote("Couldn't reach " + RegRead("server") + ". Check this TV's internet connection.")
    else
        showNote("Something went wrong (" + res.error + "). Try again in a moment.")
    end if
    return true
end function

sub showNote(text as string)
    m.panelNote.text = text
end sub

sub showList(title as string, rows as object, note as string)
    m.mode = "list"
    m.panelTitle.text = title
    m.panelNote.text = note
    m.detail.visible = false
    m.pinEntry.visible = false
    m.items.content = ListContent(rows)
    m.items.visible = rows.Count() > 0
end sub

sub showDetail(text as string, photos as object)
    m.detailPhotos = photos
    if photos.Count() > 0 then text = text + Chr(10) + Chr(10) + "Press OK to see the " + PhotoWord(photos.Count()) + "."
    m.mode = "detail"
    m.items.visible = false
    m.pinEntry.visible = false
    m.detail.text = text
    m.detail.visible = true
    m.detail.setFocus(true)
end sub

function PhotoWord(n as integer) as string
    if n = 1 then return "photo"
    return n.ToStr() + " photos"
end function

sub openPhotos()
    m.mode = "photos"
    m.photoViewer.photos = m.detailPhotos
    m.photoViewer.start = 0
    m.photoViewer.visible = true
    m.photoViewer.open = true
    m.photoViewer.setFocus(true)
end sub

sub onPhotosClosed()
    m.photoViewer.visible = false
    m.mode = "detail"
    m.detail.setFocus(true)
end sub

' --- Menu ------------------------------------------------------------------
sub onMenuSelected()
    item = m.menu.content.getChild(m.menu.itemSelected)
    if item = invalid then return
    if item.id = "signout"
        showList("Sign out of this TV", [], "Signing out...")
        ApiCall({ method: "POST", path: "/auth/logout" }, onSignedOut)
        return
    end if
    openSection(item.id)
    if m.items.visible then m.items.setFocus(true)
end sub

sub openSection(id as string)
    ApiCancelAll()
    m.section = id
    if id = "capsules"
        showList("Time Capsules", [], "Loading...")
        ApiCall({ method: "GET", path: "/api/history/capsules" }, onCapsules)
    else if Left(id, 8) = "history:"
        m.historyStudent = Mid(id, 9)
        m.historyItems = {}
        m.historyRows = []
        showList("History", [], "Loading...")
        loadHistory("")
    else if id = "lock"
        showLockMenu("")
    end if
end sub

sub onSignedOut(res as object, tag as string)
    print "EduOS: sign-out "; tag; " "; res.status
    ForgetSession()
    m.top.outcome = { go: "pair", note: "This TV is signed out." }
end sub

' --- Time Capsules ---------------------------------------------------------
sub onCapsules(res as object, tag as string)
    if m.section <> "capsules" or handled(res) then return
    rows = []
    list = res.data.data
    if type(list) = "roArray"
        for each c in list
            line = Str2(c.title, "Time Capsule") + "  -  for " + Str2(c.studentName)
            rows.Push({ id: Str2(c.id), title: line, description: StatusText(c.status) })
        end for
    end if
    note = Str2(rows.Count()) + " Time Capsules. Choose one to read it."
    if rows.Count() = 1 then note = "1 Time Capsule. Choose it to read it."
    if rows.Count() = 0 then note = "No Time Capsules yet. They're made in EduOS on a phone or computer."
    showList("Time Capsules", rows, note)
    print "EduOS: capsules "; tag
end sub

sub openCapsule(id as string)
    m.panelNote.text = "Opening..."
    ApiCall({ method: "GET", path: "/api/history/capsules/" + id }, onCapsule)
end sub

sub onCapsule(res as object, tag as string)
    if m.section <> "capsules" or handled(res) then return
    c = res.data.data
    if type(c) <> "roAssociativeArray" then return
    m.panelNote.text = ""
    lines = [Str2(c.title, "Time Capsule"), "For " + Str2(c.studentName) + "  |  " + StatusText(c.status) + "  |  " + OpensText(c), ""]
    if Str2(c.message) <> "" then lines.Append([Str2(c.message), ""])
    photos = []
    if type(c.photos) = "roArray" then photos.Append(c.photos)
    items = c.items
    if type(items) = "roArray" and items.Count() > 0
        lines.Push("Inside:")
        for each i in items
            if IsTrue(i.withheld)
                lines.Push("-  One item isn't shown here: it's no longer shared.")
            else
                when = NiceDate(i.occurredAt)
                head = "-  " + Str2(i.title, "History item")
                if when <> "" then head = head + "  (" + when + ")"
                lines.Push(head)
                if Str2(i.body) <> "" then lines.Push("   " + Str2(i.body))
                if type(i.photos) = "roArray" then photos.Append(i.photos)
            end if
        end for
    else if Str2(c.status) <> "released"
        lines.Push("What's inside stays sealed until it opens.")
    end if
    showDetail(lines.Join(Chr(10)), photos)
    print "EduOS: capsule "; tag
end sub

' --- History ---------------------------------------------------------------
sub loadHistory(cursor as string)
    path = "/api/history/portfolio"
    sep = "?"
    if m.historyStudent <> ""
        path = path + "?studentId=" + m.historyStudent
        sep = "&"
    end if
    if cursor <> "" then path = path + sep + "cursor=" + CreateObject("roUrlTransfer").Escape(cursor)
    ApiCall({ method: "GET", path: path }, onHistory)
end sub

sub onHistory(res as object, tag as string)
    if Left(m.section, 8) <> "history:" or handled(res) then return
    d = res.data.data
    if type(d) <> "roAssociativeArray" then return
    name = "History"
    if type(d.student) = "roAssociativeArray" then name = "History: " + Str2(d.student.name)
    if m.historyRows.Count() > 0 and m.historyRows.Peek().id = "__more" then m.historyRows.Pop()
    if type(d.items) = "roArray"
        for each i in d.items
            id = Str2(i.id)
            m.historyItems[id] = i
            when = NiceDate(i.occurredAt)
            title = Str2(i.title, "History item")
            if when <> "" then title = when + "   " + title
            m.historyRows.Push({ id: id, title: title })
        end for
    end if
    m.nextCursor = Str2(d.nextCursor)
    if m.nextCursor <> "" then m.historyRows.Push({ id: "__more", title: "Show more..." })
    note = "Choose an item to read it."
    if m.historyRows.Count() = 0 then note = "Nothing in the history yet."
    focusAt = m.items.itemFocused
    showList(name, m.historyRows, note)
    if focusAt > 0 and focusAt < m.historyRows.Count() then m.items.jumpToItem = focusAt
    print "EduOS: history "; tag
end sub

function Words(value as dynamic) as string
    s = Str2(value).Replace("_", " ")
    if s = "" then return ""
    return UCase(Left(s, 1)) + Mid(s, 2)
end function

sub openHistoryItem(id as string)
    if id = "__more"
        m.panelNote.text = "Loading more..."
        loadHistory(m.nextCursor)
        return
    end if
    i = m.historyItems[id]
    if i = invalid then return
    facts = []
    if Words(i.entryType) <> "" then facts.Push(Words(i.entryType))
    if Words(i.kind) <> "" then facts.Push(Words(i.kind))
    if NiceDate(i.occurredAt) <> "" then facts.Push(NiceDate(i.occurredAt))
    if Str2(i.schoolYear) <> "" then facts.Push("School year " + Str2(i.schoolYear))
    lines = [Str2(i.title, "History item"), facts.Join("  |  ")]
    if Str2(i.authorName) <> "" then lines.Push("By " + Str2(i.authorName))
    if Str2(i.transferredFrom) <> "" then lines.Push("Came from " + Str2(i.transferredFrom))
    lines.Push("")
    if Str2(i.body) <> "" then lines.Push(Str2(i.body))
    photos = []
    if type(i.photos) = "roArray" then photos = i.photos
    showDetail(lines.Join(Chr(10)), photos)
end sub

' --- Screen lock -------------------------------------------------------------
sub showLockMenu(note as string)
    minutes = IntOf(RegRead("autoLock"))
    if minutes < 5 or minutes > 30 then minutes = 10
    if HasPin()
        rows = [
            { id: "change", title: "Change the PIN" },
            { id: "off", title: "Turn off the screen lock" },
            { id: "minutes", title: "Lock after " + minutes.ToStr() + " quiet minutes (choose to change)" },
            { id: "now", title: "Lock now" }
        ]
        if note = "" then note = "This TV asks for the PIN when EduOS starts and after a quiet spell."
    else
        rows = [
            { id: "set4", title: "Set a 4-number PIN" },
            { id: "set6", title: "Set a 6-number PIN" }
        ]
        if note = "" then note = "Add a PIN so only your family can open EduOS on this TV."
    end if
    showList("Screen lock", rows, note)
end sub

sub onLockChoice(id as string)
    if id = "set4" or id = "set6"
        m.newLength = 4
        if id = "set6" then m.newLength = 6
        askPin("new", "Choose a " + m.newLength.ToStr() + "-number PIN.", m.newLength)
    else if id = "change"
        m.pinGoal = "change"
        askPin("verify", "Enter the current PIN.", currentPinLength())
    else if id = "off"
        m.pinGoal = "off"
        askPin("verify", "Enter the current PIN to turn the lock off.", currentPinLength())
    else if id = "minutes"
        minutes = IntOf(RegRead("autoLock"))
        nextChoice = { "5": 10, "10": 15, "15": 30, "30": 5 }
        key = minutes.ToStr()
        if not nextChoice.DoesExist(key) then key = "10"
        RegWrite("autoLock", nextChoice[key].ToStr())
        showLockMenu("Saved.")
        m.items.jumpToItem = 2
    else if id = "now"
        m.top.outcome = { go: "lock", note: "" }
    end if
end sub

function currentPinLength() as integer
    parts = RegRead("pin").Split("|")
    if parts.Count() = 3 then return IntOf(parts[2])
    return 4
end function

sub askPin(stepName as string, prompt as string, length as integer)
    m.mode = "pin"
    m.pinStep = stepName
    m.items.visible = false
    m.detail.visible = false
    m.panelNote.text = prompt
    m.pinEntry.length = length
    m.pinEntry.reset = true
    m.pinEntry.visible = true
    m.pinEntry.setFocus(true)
end sub

sub onPinDone()
    pin = m.pinEntry.done
    noteActivity()
    if m.pinStep = "verify"
        if PinWaitSeconds() > 0
            backToLockMenu("Too many wrong PINs. Try again in " + PinWaitSeconds().ToStr() + " seconds.")
        else if not PinMatches(pin)
            NotePinFailure()
            backToLockMenu("That PIN isn't right.")
        else if m.pinGoal = "off"
            NotePinSuccess()
            RegWrite("pin", "")
            backToLockMenu("The screen lock is off.")
        else
            NotePinSuccess()
            m.newLength = currentPinLength()
            askPin("new", "Choose the new " + m.newLength.ToStr() + "-number PIN.", m.newLength)
        end if
    else if m.pinStep = "new"
        m.firstPin = pin
        askPin("confirm", "Enter the same PIN again.", m.newLength)
    else if m.pinStep = "confirm"
        if pin = m.firstPin
            SavePin(pin)
            backToLockMenu("PIN saved. EduOS asks for it when it starts on this TV.")
        else
            askPin("new", "Those didn't match. Choose a " + m.newLength.ToStr() + "-number PIN.", m.newLength)
        end if
    end if
end sub

sub backToLockMenu(note as string)
    m.firstPin = ""
    showLockMenu(note)
    m.items.setFocus(true)
end sub

' --- Selection and keys ---------------------------------------------------------
sub onItemSelected()
    noteActivity()
    item = m.items.content.getChild(m.items.itemSelected)
    if item = invalid then return
    if m.section = "capsules"
        openCapsule(item.id)
    else if Left(m.section, 8) = "history:"
        openHistoryItem(item.id)
    else if m.section = "lock"
        onLockChoice(item.id)
    end if
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    noteActivity()
    if m.mode = "pin" and (key = "back" or key = "left")
        backToLockMenu("")
        return true
    end if
    if m.mode = "detail" and key = "OK" and m.detailPhotos.Count() > 0
        openPhotos()
        return true
    end if
    if m.mode = "detail" and (key = "back" or key = "left")
        m.mode = "list"
        m.detail.visible = false
        m.items.visible = true
        m.items.setFocus(true)
        return true
    end if
    if m.menu.hasFocus() and key = "right" and m.items.visible
        m.items.setFocus(true)
        return true
    end if
    if m.items.hasFocus() and (key = "left" or key = "back")
        m.menu.setFocus(true)
        return true
    end if
    return false
end function
