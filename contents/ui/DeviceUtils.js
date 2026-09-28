
// Shared device utilities

// unwrapVariant: a gdbus reply is one value wrapped in a tuple, and stdout
// adds a trailing newline. "('Phone',)\n" -> "'Phone'"
function unwrapVariant(stdout) {
    const tuple = (stdout || "").trim().match(/^\((.*),\)$/);
    return tuple ? tuple[1].trim() : "";
}

// scanStrings: every quoted run in the text, in order, turned into a string.
// Quoted values are the only ones returned, so numbers, booleans and "@as"
// arrays are skipped: "(['a', \"b's\"],)\n" -> ["a", "b's"], "(@as [],)" -> []
// An unterminated quote yields nothing.
function scanStrings(text) {
    const runs = [];
    let i = 0;
    while (i < text.length) {
        const quote = text[i];
        if (quote !== "'" && quote !== '"') {
            i++;
            continue;
        }
        let escaped = false;
        let closed = false;
        const start = i;
        for (i++; i < text.length; i++) {
            if (escaped)
                escaped = false;
            else if (text[i] === "\\")
                escaped = true;
            else if (text[i] === quote) {
                closed = true;
                break;
            }
        }
        if (closed)
            runs.push(unquote(text.slice(start, i + 1)));
        i++;
    }
    return runs;
}

// unquote: strips the surrounding quotes and resolves the only two escapes
// gdbus can produce for these values - the delimiter and a backslash.
// "'it\'s'" -> "it's", "'a\\\\b'" -> "a\b"
function unquote(run) {
    return run.slice(1, -1).replace(/\\(['"\\])/g, "$1");
}

// gvariantValue: reads one key out of a GetAll reply and unquotes it if it is
// a string, so callers get a string for names and a raw token for the rest.
// "({'name': <\"Bob's Phone\">, 'charge': <-1>},)\n" + "name" -> "Bob's Phone"
function gvariantValue(stdout, key) {
    const entry = unwrapVariant(stdout).match(new RegExp("['\"]" + key + "['\"]:\\s*<([^>]*)>"));
    if (!entry)
        return null;
    const value = entry[1].trim();
    return value.startsWith("'") || value.startsWith("\"") ? (scanStrings(value)[0] || "") : value;
}

function getIconForType(deviceType) {
    switch (deviceType) {
        case "gaming-input":
        case "gamepad":
            return "input-gamepad"
        case "mouse":
            return "input-mouse"
        case "touchpad":
            return "input-touchpad"
        case "keyboard":
            return "input-keyboard"
        case "phone":
        case "smartphone":
            return "smartphone"
        case "tablet":
            return "tablet"
        case "headphones":
            return "audio-headphones"
        case "headset":
            return "audio-headset"
        case "monitor":
        case "display":
            return "video-display"
        case "desktop":
            return "computer"
        case "laptop":
            return "computer-laptop"
        case "tv":
            return "video-television"
        default:
            return "battery-symbolic"
    }
}
