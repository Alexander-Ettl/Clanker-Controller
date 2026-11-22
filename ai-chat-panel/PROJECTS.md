# Set up a project in Clanker Controller

1. Open Clanker Controller. Click the project name at the top of the chat, or **Choose project**.
2. Select **Add project…**, choose your folder wherever it lives, and give the project a name. Folders already open in VS Code are listed automatically.
3. Write your prompt. This conversation, its queue, and its CLI sessions stay with that project.
   Clicking a project on the rail moves a chat nothing was sent in yet to that project, so the model you picked stays and you can run a `/` command right there. A chat that already has messages stays with its project; clicking another project opens that project's latest chat.
4. To work on another project alongside this one, run **Clanker Controller:New Chat Window** from the Command Palette, then select its project. Switching editor tabs won't change a chat's destination.
5. Choosing a project shows its folder in VS Code's Explorer, adding it to the workspace if needed. Save the VS Code workspace if you want that Explorer layout again.

Use **Manage projects…** in the project menu to rename a project or locate its folder after a move. Stop its running work before changing folders; chat history stays, while native CLI sessions restart in the new location.

The sidebar shows three projects by default (Settings > General > Projects in the sidebar, `aiChatPanel.railProjects`; 1 to 10, or All for a very large monitor). The current project always stays; pinned favorites (up to two) come next, then the projects with the most recent chat activity. With nothing pinned, all three slots follow recent activity. Registered projects fill any gaps when there is no history, and with fewer projects than slots each appears once. The same section sets how many recent chats the rail lists (`aiChatPanel.railChats`, default 5, or All). This keeps the section height steady when switching into a pinned project. **All projects** (the grid button below those tiles) opens a visual list with icons, names and running status. Unpin a favorite there to pin another. Your favorites survive reloads and are shared across chat windows. Hidden projects, chats and scheduled prompts remain open and keep running. A green dot on All projects indicates running work in a hidden project. Add and Manage projects are available inside the grid.

Choose **New planning project…** if you don't have a folder yet. Attach one later through **Manage projects… → Locate / attach folder**.

Older conversations ask you to choose their project once. Select the folder those conversations actually belonged to. Clanker keeps their messages and available attachments, and starts fresh CLI sessions for that folder.

Projects are stored locally for each extension user. Names and paths come from their choices; no shared parent directory or cloud account is required. Registration and separate histories aren't a filesystem sandbox: CLI access still follows the permission mode you select.

See [Chat storage and recovery](../docs/chat-recovery.md) for automatic backup and restoration of chat history and project settings.
