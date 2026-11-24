sub init()
    m.slots = m.top.findNode("slots")
    onReset()
end sub

sub onReset()
    m.digits = []
    m.current = 0
    render()
end sub

sub render()
    while m.slots.getChildCount() > 0
        m.slots.removeChildIndex(0)
    end while
    for i = 0 to m.top.length - 1
        slot = m.slots.createChild("Rectangle")
        slot.width = 120
        slot.height = 160
        slot.translation = [i * 150, 0]
        slot.color = "0x22335CFF"
        if i = m.digits.Count() then slot.color = "0xFCA311FF"
        txt = slot.createChild("Label")
        txt.width = 120
        txt.height = 160
        txt.horizAlign = "center"
        txt.vertAlign = "center"
        txt.font = "font:LargeBoldSystemFont"
        txt.color = "0xFFFFFFFF"
        if i < m.digits.Count()
            txt.text = "*"
        else if i = m.digits.Count()
            txt.text = m.current.ToStr()
            txt.color = "0x14213DFF"
        end if
    end for
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "up"
        m.current = (m.current + 1) mod 10
    else if key = "down"
        m.current = (m.current + 9) mod 10
    else if key = "right" or key = "OK"
        m.digits.Push(m.current.ToStr())
        m.current = 0
        if m.digits.Count() >= m.top.length
            pin = m.digits.Join("")
            m.digits = []
            render()
            m.top.done = pin
            return true
        end if
    else if key = "left"
        if m.digits.Count() = 0 then return false
        m.current = Int(Val(m.digits.Pop()))
    else
        return false
    end if
    render()
    return true
end function
