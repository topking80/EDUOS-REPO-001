sub draw()
    while m.top.getChildCount() > 0
        m.top.removeChildIndex(0)
    end while
    rows = m.top.rows
    if rows = invalid or rows.Count() = 0 then return
    quiet = 4
    modules = rows.Count() + quiet * 2
    cell = Int(m.top.size / modules)
    if cell < 2 then cell = 2
    paper = m.top.createChild("Rectangle")
    paper.width = cell * modules
    paper.height = cell * modules
    paper.color = "0xFFFFFFFF"
    y = 0
    for each row in rows
        x = 0
        n = Len(row)
        while x < n
            if Mid(row, x + 1, 1) = "1"
                runStart = x
                while x < n and Mid(row, x + 1, 1) = "1"
                    x = x + 1
                end while
                dark = m.top.createChild("Rectangle")
                dark.color = "0x000000FF"
                dark.width = (x - runStart) * cell
                dark.height = cell
                dark.translation = [(runStart + quiet) * cell, (y + quiet) * cell]
            else
                x = x + 1
            end if
        end while
        y = y + 1
    end for
end sub
