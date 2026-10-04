# Set up a project in Clanker Controller

1. Open Clanker Controller. Click the project name at the top of the chat, or **Choose project**.
2. Select **Add project…**, choose your folder wherever it lives, and give the project a name. Folders already open in VS Code are listed automatically.
3. Write your prompt. This conversation, its queue, and its CLI sessions stay with that project.
4. To work on another project alongside this one, run **Clanker Controller:New Chat Window** from the Command Palette, then select its project. Switching editor tabs won't change a chat's destination.
5. Click the folder icon beside the project name to add its folder to VS Code's Explorer. Save the VS Code workspace if you want that Explorer layout again.

Use **Manage projects…** in the project menu to rename a project or locate its folder after a move. Stop its running work before changing folders; chat history stays, while native CLI sessions restart in the new location.

Choose **New planning project…** if you don't have a folder yet. Attach one later through **Manage projects… → Locate / attach folder**.

Older conversations ask you to choose their project once. Select the folder those conversations actually belonged to. Clanker keeps their messages and available attachments, and starts fresh CLI sessions for that folder.

Projects are stored locally for each extension user. Names and paths come from their choices; no shared parent directory or cloud account is required. Registration and separate histories aren't a filesystem sandbox: CLI access still follows the permission mode you select.
