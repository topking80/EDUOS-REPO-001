sub init()
    m.global.addFields({ activityAt: CreateObject("roDateTime").AsSeconds() })
    m.stages = {
        setup: m.top.findNode("setup"),
        pair: m.top.findNode("pair"),
        lock: m.top.findNode("lock"),
        home: m.top.findNode("home")
    }
    for each name in m.stages
        m.stages[name].ObserveField("outcome", "onOutcome")
    end for
    m.idle = m.top.findNode("idleTimer")
    m.idle.ObserveField("fire", "onIdleCheck")
    m.idle.control = "start"
    m.stage = ""
    startStage("")
end sub

' Where to begin: no district yet -> setup; no session -> pair; PIN -> lock.
sub startStage(note as string)
    if RegRead("server") = ""
        show("setup", note)
    else if RegRead("token") = ""
        show("pair", note)
    else if HasPin()
        show("lock", note)
    else
        show("home", note)
    end if
end sub

sub show(name as string, note as string)
    for each key in m.stages
        stage = m.stages[key]
        if key <> name and stage.visible
            stage.active = false
            stage.visible = false
        end if
    end for
    m.stage = name
    target = m.stages[name]
    target.note = note
    target.visible = true
    target.active = true
    target.setFocus(true)
    m.global.activityAt = CreateObject("roDateTime").AsSeconds()
end sub

' Each stage reports {go, note} when it's done.
sub onOutcome(event as object)
    out = event.GetData()
    if out = invalid or out.go = invalid then return
    note = Str2(out.note)
    if out.go = "next"
        startStage(note)
    else
        show(out.go, note)
    end if
end sub

' Screen lock after a quiet spell (5-30 minutes, default 10).
sub onIdleCheck()
    if m.stage <> "home" or not HasPin() then return
    minutes = IntOf(RegRead("autoLock"))
    if minutes < 5 or minutes > 30 then minutes = 10
    if CreateObject("roDateTime").AsSeconds() - m.global.activityAt >= minutes * 60
        show("lock", "Locked after " + minutes.ToStr() + " quiet minutes.")
    end if
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    ' Keys the stages didn't use still count as someone being there.
    if press and key <> "" then m.global.activityAt = CreateObject("roDateTime").AsSeconds()
    return false
end function
