' Helpers shared by the EduOS components (included with <script uri>).

' --- Saved settings (roRegistrySection "eduos") -----------------------------
' Keys: server (https origin), token, csrf, role, clientKind, pin (salt|hash).
function RegRead(key as string) as string
    sec = CreateObject("roRegistrySection", "eduos")
    if sec.Exists(key) then return sec.Read(key)
    return ""
end function

sub RegWrite(key as string, value as string)
    sec = CreateObject("roRegistrySection", "eduos")
    if value = ""
        sec.Delete(key)
    else
        sec.Write(key, value)
    end if
    sec.Flush()
end sub

' Forget the sign-in (and with it the screen-lock PIN, like the phone app).
sub ForgetSession()
    for each key in ["token", "csrf", "role", "clientKind", "pin", "pinTries", "pinLockedUntil"]
        RegWrite(key, "")
    end for
end sub

' --- District address ----------------------------------------------------
' Accepts "district.example.org" or "https://district.example.org/"; returns
' the https origin, or "" when it isn't one. Plain http is never accepted: the
' session token travels in a header.
function NormalizeServer(raw as string) as string
    s = LCase(raw.Trim())
    if s = "" then return ""
    if Left(s, 7) = "http://" then return ""
    if Left(s, 8) <> "https://" then s = "https://" + s
    rest = Mid(s, 9)
    slash = Instr(1, rest, "/")
    if slash > 0 then rest = Left(rest, slash - 1)
    if rest = "" or Instr(1, rest, "@") > 0 or Instr(1, rest, " ") > 0 then return ""
    if Instr(1, rest, ".") = 0 then return ""
    return "https://" + rest
end function

' --- Text ----------------------------------------------------------------
function Str2(value as dynamic, fallback = "" as string) as string
    if value = invalid then return fallback
    if type(value) = "roString" or type(value) = "String" then return value
    t = type(value)
    if t = "roInt" or t = "Integer" or t = "roInteger" or t = "LongInteger" or t = "roLongInteger" then return value.ToStr()
    if t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble" then return Str(value).Trim()
    return fallback
end function

' True only for a real true (JSON fields can be missing, and comparing
' invalid with a boolean is a runtime error).
function IsTrue(value as dynamic) as boolean
    t = type(value)
    if t = "Boolean" or t = "roBoolean" then return value
    return false
end function

' Whole number from saved text ("" -> 0).
function IntOf(text as string) as integer
    return Int(Val(text))
end function

' "2027-06-12T00:00:00.000Z" -> "June 12, 2027"
function NiceDate(iso as dynamic) as string
    s = Str2(iso)
    if Len(s) < 10 then return ""
    d = CreateObject("roDateTime")
    d.FromISO8601String(Left(s, 10) + "T12:00:00Z")
    return d.AsDateString("no-weekday")
end function

function MilestoneText(milestone as dynamic) as string
    ' Same wording as the phone app (lib/core/history_models.dart).
    names = {
        grade_5_completion: "Finishing grade 5",
        grade_8_completion: "Finishing grade 8",
        graduation: "Graduation",
        age_18: "Turning 18"
    }
    key = Str2(milestone)
    if names.DoesExist(key) then return names[key]
    if key = "" then return "a milestone"
    return key.Replace("_", " ")
end function

function OpensText(c as object) as string
    if Str2(c.releaseKind) = "milestone" then return "Opens at: " + MilestoneText(c.milestone)
    return "Opens " + NiceDate(c.releaseAt)
end function

function StatusText(status as dynamic) as string
    s = Str2(status)
    if s = "draft" then return "Draft"
    if s = "sealed" then return "Sealed, waiting for the milestone"
    if s = "scheduled" then return "Sealed"
    if s = "released" then return "Released"
    if s = "cancelled" then return "Cancelled"
    return s
end function

' --- Screen-lock PIN ------------------------------------------------------
' Stored as "salt|hash|length": the hash is HMAC-SHA256 of the PIN, keyed with
' a random salt and re-applied 2000 times. It only guards this TV's screen;
' the district session is still the real permission.
function PinHash(pin as string, salt as string) as string
    key = CreateObject("roByteArray")
    key.FromAsciiString(salt)
    hmac = CreateObject("roHMAC")
    hmac.Setup("sha256", key)
    data = CreateObject("roByteArray")
    data.FromAsciiString(pin)
    for i = 1 to 2000
        data = hmac.Process(data)
    end for
    return data.ToHexString()
end function

sub SavePin(pin as string)
    salt = CreateObject("roDeviceInfo").GetRandomUUID()
    RegWrite("pin", salt + "|" + PinHash(pin, salt) + "|" + Len(pin).ToStr())
    RegWrite("pinTries", "")
    RegWrite("pinLockedUntil", "")
end sub

function HasPin() as boolean
    return RegRead("pin") <> ""
end function

function PinMatches(pin as string) as boolean
    parts = RegRead("pin").Split("|")
    if parts.Count() <> 3 then return false
    return PinHash(pin, parts[0]) = parts[1]
end function

' Five free tries, then a wait that starts at 30 seconds and doubles to 15 minutes.
function PinWaitSeconds() as integer
    lockedUntil = IntOf(RegRead("pinLockedUntil"))
    now = CreateObject("roDateTime").AsSeconds()
    if lockedUntil > now then return lockedUntil - now
    return 0
end function

sub NotePinFailure()
    tries = IntOf(RegRead("pinTries")) + 1
    RegWrite("pinTries", tries.ToStr())
    if tries >= 5
        delay = 30
        for i = 6 to tries
            delay = delay * 2
        end for
        if delay > 900 then delay = 900
        RegWrite("pinLockedUntil", (CreateObject("roDateTime").AsSeconds() + delay).ToStr())
    end if
end sub

sub NotePinSuccess()
    RegWrite("pinTries", "")
    RegWrite("pinLockedUntil", "")
end sub

' --- Lists -----------------------------------------------------------------
function ListContent(rows as object) as object
    content = CreateObject("roSGNode", "ContentNode")
    for each r in rows
        item = content.CreateChild("ContentNode")
        item.title = r.title
        if r.id <> invalid then item.id = r.id
        if r.description <> invalid then item.description = r.description
    end for
    return content
end function
