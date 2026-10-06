/** Strings for till pairing, PIN unlock, manager override and their back-office screens. Merged into en-IE. */
export const deviceEnIE = {
  // Pair page (on the till)
  "pair.title": "Pair this till",
  "pair.body":
    "A manager makes a pairing code in the back office under Settings, Tills. Type it here. The till then belongs to your shop.",
  "pair.code": "Pairing code",
  "pair.codeHint": "8 letters and numbers. It works once and expires after 10 minutes.",
  "pair.submit": "Pair this till",
  "pair.working": "Pairing…",
  "pair.network": "Could not reach the server. Check the internet connection and try again.",
  "pair.invalid": "That code is not valid or has expired. Ask a manager for a new one.",

  // Lock screen
  "lock.title": "Who is using the till?",
  "lock.pickHint": "Choose your name, then enter your PIN.",
  "lock.noStaff":
    "Nobody has set a PIN yet. Sign in to the back office and set one under Settings, My till PIN.",
  "lock.enterPin": "PIN for {name}",
  "lock.pinLabel": "PIN",
  "lock.digitsEntered": "{count} digits entered",
  "lock.delete": "Delete last digit",
  "lock.unlock": "Unlock",
  "lock.checking": "Checking…",
  "lock.back": "Choose another name",
  "lock.lockTill": "Lock till",
  "lock.pinHint": "4 to 6 digits.",
  "lock.pad": "Number pad",
  "lock.lock": "Lock",
  "lock.serving": "Serving: {name}",
  "lock.invalid": "That PIN is not right.",
  "lock.locked":
    "Too many wrong PINs. Locked until {time}. A manager can reset the PIN in the back office.",
  "lock.limited": "Too many tries on this till. Wait a few minutes and try again.",
  "lock.unpaired": "This till is no longer paired. Ask a manager for a new pairing code.",
  "lock.offlineHint": "No connection: checking against the PIN saved on this till.",
  "lock.role.owner": "Owner",
  "lock.role.manager": "Manager",
  "lock.role.cashier": "Cashier",

  // Override dialog
  "override.title": "Manager approval needed",
  "override.discount":
    "This discount is above the shop's limit of {percent}. A manager or owner must enter their PIN.",
  "override.noSale": "Opening the drawer without a sale needs a manager or owner PIN.",
  "override.approve": "Approve",
  "override.approved": "Approved by {name}.",
  "override.noManagers":
    "No manager or owner has set a PIN yet, so this cannot be approved. Set one in the back office.",
  "override.notAllowed": "That PIN belongs to someone who cannot approve this. Ask a manager.",

  // Register extras
  "register.openDrawer": "Open drawer",
  "register.drawerOpened": "Drawer opened. This was recorded.",
  "register.drawerNoPrinter":
    "The drawer opens through the receipt printer. Set up a printer first.",
  "register.drawerFailed": "The printer could not be reached, so the drawer did not open.",
  "register.unpairedTitle": "This till is not paired",
  "register.unpairedBody":
    "The server no longer knows this device. Sales already rung up are safe on it. Ask a manager for a pairing code to carry on.",
  "register.unpairedAction": "Pair this till",
  "register.signedOutNotice":
    "This till is no longer paired with the server. Sales are safe on this device; pair it again to send them.",

  // Back office: tills
  "tills.title": "Tills",
  "tills.body":
    "Pair each till (a tablet or computer) once with a one-time code. Revoke a till that is lost or replaced: it stops working at once.",
  "tills.paired": "Paired",
  "tills.notPaired": "Not paired",
  "tills.lastSeen": "Last seen {when}",
  "tills.neverSeen": "Never seen",
  "tills.pair": "Pair",
  "tills.pairAgain": "Pair again",
  "tills.revoke": "Revoke",
  "tills.revokeFor": "Revoke {name}",
  "tills.pairFor": "Pair {name}",
  "tills.revokeConfirm":
    "Revoke {name}? It stops working immediately. Sales waiting on the device stay there and are sent once it is paired again.",
  "tills.revokeYes": "Yes, revoke",
  "tills.codeTitle": "Pairing code for {name}",
  "tills.codeBody":
    "On the till, open the register and type this code. It works once and expires at {time}. Write it down now: it is not shown again.",
  "tills.done": "Done",
  "tills.add": "Add a till",
  "tills.addName": "Till name",
  "tills.addSubmit": "Add till",
  "tills.empty": "This shop has no tills yet.",
  "tills.revoked": "{name} was revoked.",
  "tills.added": "Till added.",
  "tills.error": "Something went wrong. Please try again.",
  "tills.nameTaken": "A till with that name already exists.",

  // Back office: my PIN
  "pin.title": "My till PIN",
  "pin.body":
    "Your name and PIN unlock the till. Use 4 to 6 digits and avoid 1234 or the same digit repeated. Only you and the till know it: it is stored scrambled.",
  "pin.name": "Name shown on the till",
  "pin.pin": "New PIN",
  "pin.confirm": "Repeat the PIN",
  "pin.save": "Save PIN",
  "pin.saved": "PIN saved. You can use it on the till at its next catalogue update.",
  "pin.mismatch": "The two PINs do not match.",
  "pin.error": "We could not save the PIN. Please try again.",
  "pin.hasPin": "A PIN is set.",
  "pin.noPin": "No PIN set yet.",

  // Back office: staff
  "staff.title": "Staff",
  "staff.body":
    "Everyone with access to this shop. A manager can clear a cashier's PIN if it is forgotten or locked.",
  "staff.name": "Name",
  "staff.role": "Role",
  "staff.pin": "Till PIN",
  "staff.pinSet": "Set",
  "staff.pinNone": "Not set",
  "staff.pinLocked": "Locked until {time}",
  "staff.noName": "Not named yet",
  "staff.reset": "Reset PIN",
  "staff.resetFor": "Reset PIN for {name}",
  "staff.resetDone": "PIN cleared. They can set a new one under My till PIN.",
  "staff.error": "Something went wrong. Please try again.",

  // Back office: discount limit
  "discountLimit.title": "Discount approval limit",
  "discountLimit.body":
    "A discount above this share of a line, or of the whole sale, needs a manager or owner PIN on the till.",
  "discountLimit.percent": "Limit (% off)",
  "discountLimit.save": "Save limit",
  "discountLimit.saved": "Limit saved.",
  "discountLimit.invalid": "Enter a whole number or a number with one or two decimals, 0 to 100.",
  "discountLimit.error": "We could not save the limit. Please try again.",
} as const;
