# 🚀 In-App Builder: Your Plugin's Workshop, Inside Obsidian! 🚀

<p align="center">
  <img src="https://img.shields.io/badge/status-BETA%20%7C%20Usable,%20but%20buggy!-orange" alt="Status: Beta | Usable, but buggy!">
</p>

## The "Why" - A Rant from the Author

Let's be honest. I love making plugins for Obsidian. It's fun, it's rewarding, and it lets me tailor my favorite app to my exact needs. But you know what I *don't* love? The ceremony.

Every time I wanted to tweak a tiny bit of TypeScript, I had to:
1.  Open my code editor.
2.  Run `npm install`.
3.  Run `npm run build`.
4.  Wait for my slow laptop to finish.
5.  Copy the `main.js`, `manifest.json`, and `styles.css` into my vault's `.obsidian/plugins` folder.
6.  Go back to Obsidian, disable and re-enable the plugin.
7.  Pray it worked.

And if I was away from my main computer? Forget it. Trying to get a Node.js environment running on a tablet or a friend's laptop, or wrestling with Replit or GitHub Actions just to compile a 50-line plugin... it was infuriating.

So, I built this. **In-App Builder** is my solution. It's a plugin that builds other plugins, right inside Obsidian. It uses the magic of `esbuild-wasm` to compile, bundle, and spit out your finished plugin files directly into your vault. No Node.js, no npm, no command line. Just you, your code, and Obsidian.

## ⚠️ A Word of Warning: This is a BETA!

I'm putting this out there because I think it's already useful, but let's set some expectations:

*   **IT HAS BUGS.** I know it does. I've probably created more bugs than features. But I also know that it's *pretty much usable* if you're willing to put in a little effort and maybe reload Obsidian once or twice.
*   **THE CACHE IS A LIE.** You'll see a beautiful "Enable Caching" toggle in the settings. It looks great. It even toggles. **It does nothing.** I have plans to make it work, but for now, it's just there to remind me of my ambitions. Turning it on won't break anything, but it won't help either. The plugin will fetch esbuild from the CDN every time you load Obsidian.
*   **I CAN'T PROMISE SUPPORT.** I built this to solve my own problem. I'm sharing it in case it solves yours too. I might fix bugs, I might add features, or I might get distracted by a shiny new idea and forget this exists for six months. There are no guarantees.

Think of this as a powerful, but slightly untamed, tool.

## ✨ Features (What it CAN do)

Despite the warnings, this thing is packed with features because, well, I needed them!

*   **In-Vault TypeScript/JavaScript Bundling:** The core of the plugin. It uses a WASM-powered version of esbuild to bundle your code.
*   **Full Project Management:** Create, edit, and delete multiple build "projects" from a central settings panel. You can work on all your plugins from one place.
*   **Deep esbuild Configuration:** The project creation/editing modal gives you control over a ton of esbuild options:
    *   **Bundling:** `bundle` (of course!)
    *   **Minification:** `minify`, `minifyWhitespace`, `minifyIdentifiers`, `minifySyntax`.
    *   **Sourcemaps:** Generate separate, inline, or no sourcemaps at all.
    *   **Output:** Control the `format` (cjs, esm), `platform` (browser, node), and `target` (es2018, etc.).
    *   **Advanced:** Configure `define` for global constants, `external` for modules to exclude (like `obsidian`, which is excluded by default), custom `resolveExtensions`, and even file `loader` overrides.
*   **CDN Dependencies:** Need `moment.js` or `react`? Just add the CDN URL to the project's dependency list, and the builder will make it available to esbuild.
*   **Command Palette Integration:** Every project you create automatically gets its own command in Obsidian: `In-App Builder: Build: [Your Project Name]`.
*   **Robust Diagnostics:** If a build fails, it's not a black box. You can copy a detailed diagnostic report that includes project settings, file hashes, and the raw error output from esbuild to help you figure out what went wrong.

## 🔧 How to Use It

Ready to dive in? Here's the workflow.

### Installation
For now, you'll have to install it manually.
1.  Download the `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Yuichi-Aragi/IAB).
2.  Create a new folder named `in-app-builder` inside your vault's `.obsidian/plugins/` directory.
3.  Copy the downloaded files into that new folder.
4.  Go to `Settings` -> `Community Plugins`, and enable "In-App Builder".

### Step 1: Create Your Plugin's Folder
Create a folder somewhere in your vault for your new plugin's source code. For example: `MyVault/dev/MyCoolPlugin/`. Inside that folder, create your `main.ts`.

```
MyVault/
└── dev/
    └── MyCoolPlugin/
        └── main.ts
```

### Step 2: Open the Builder's Settings
Go to `Settings` -> `In-App Builder`. This is your command center.

### Step 3: Add a New Project
Click the "Add New Project" button. A modal will pop up. Fill it out:

*   **Project Name:** A friendly name, like `My Cool Plugin`.
*   **Project Path (Folder):** The path to your plugin's source folder. In our example, this would be `dev/MyCoolPlugin`. (Use `.` if your source files are in the vault root).
*   **Entry Point File:** The main file to start bundling from, relative to the Project Path. Usually `main.ts`.
*   **Output File Path:** Where to put the finished `main.js`, also relative to the Project Path. Usually just `main.js`.

The defaults for the other options are generally good for a standard Obsidian plugin.

### Step 4: Build!
You have two ways to kick off a build:

1.  **The Settings Tab Button (Recommended):** In the In-App Builder settings, find your project in the list and click the "play" icon (▶️). This method is great because it will show you pop-up notices for success, warnings, and failures.
2.  **The Command Palette:** Open the command palette (Ctrl/Cmd + P) and search for `In-App Builder: Build: My Cool Plugin`. This method is faster but **it will not show any notices**. It's great for quick rebuilds when you know what you're doing.

If the build is successful, the `main.js` (and a `main.js.map` if you enabled sourcemaps) will appear in your project's folder! You can then add a `manifest.json` and start testing your plugin in Obsidian.

## 🛣️ The Road Ahead (Future Plans)

This is just the beginning. Here's what I'm hoping to add when I'm not feeling lazy:

*   **Full esbuild Feature Parity:** Expose even more of the esbuild API in the UI.
*   **`package.json` Integration:** Automatically read dependencies and other build configurations from a `package.json` file in your project folder.
*   **Better `node_modules` Support:** A more robust system for handling in-vault `node_modules` folders.
*   **A Dedicated "Builder" View:** Instead of just a settings tab, maybe a proper sidebar pane for managing and building projects.
*   **Bug Fixes:** So. Many. Bug. Fixes.

## 💡 Important Notes & Tips

### 🌐 Internet Connection
This plugin needs an internet connection *every* time you run it after loading Obsidian. It has to download the `esbuild` library from a CDN, which is about **15 MB** approximately.

You'll know it's done when you see a success notice or the status in the settings tab says "Initialized ✓". After that, you can safely turn off your internet if you want... and hope it works, I guess.

### 📱 Mobile Development & Debugging
Developing on mobile is tough without access to the developer console. If you're trying to debug your plugin on a phone or tablet, you're going to need a way to see `console.log` messages and errors.

I recommend using a plugin like **ScriptPilot** to inject the `eruda` mobile console into Obsidian. You can find it here:

[https://github.com/Yuichi-Aragi/ScriptPilot](https://github.com/Yuichi-Aragi/ScriptPilot)

You can even use this builder plugin to build ScriptPilot itself if you're feeling meta!

---

Enjoy the builder. I hope it saves you from some of the frustration it saved me from. Happy coding
