/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50, browser: true */
/*global $, define, brackets, Mustache */

define(function (require, exports, module) {
    "use strict";
    
    var CommandManager      = brackets.getModule("command/CommandManager"),
        Menus               = brackets.getModule("command/Menus"),
        EditorManager       = brackets.getModule("editor/EditorManager"),
        ProjectManager      = brackets.getModule("project/ProjectManager"),
        AppInit             = brackets.getModule("utils/AppInit"),
        ExtensionUtils      = brackets.getModule("utils/ExtensionUtils"),
        NodeConnection      = brackets.getModule("utils/NodeConnection"),
        Dialogs             = brackets.getModule("widgets/Dialogs"),
        IssueCommentTPL     = require("text!htmlContent/issue-comment.html"),
        IssueCommentInputTPL= require("text!htmlContent/issue-comment-input.html"),
        IssueDialogNewTPL   = require("text!htmlContent/issue-dialog-new.html"),
        IssueDialogViewTPL  = require("text!htmlContent/issue-dialog-view.html"),
        IssuePanelTPL       = require("text!htmlContent/issue-panel.html"),
        IssueParticipantsTPL= require("text!htmlContent/issue-participants.html"),
        IssueTableRowTPL    = require("text!htmlContent/issue-table-row.html");
    
    var marked  = require("third_party/marked"),
        moment  = require("third_party/moment");
    
    var CMD_GH_ISSUES_LIST  = "gh_issues_list";
    var CMD_GH_ISSUES_NEW   = "gh_issues_new";

    var nodeConnection;
    
    var contextMenu     = Menus.getContextMenu(Menus.ContextMenuIds.PROJECT_MENU),
        menuItems       = [],
        buildMenuItem   = null;
    
    // Current git repo information based on the project path
    var ghRepoInfo = {};
    
    // Shortcut to gh domain
    var gh;
    
    // UI Elements
     var $issuesPanel,
         $issuesWrapper,
         $issuesList;
    
    var githubLogo = ExtensionUtils.getModulePath(module, "img/github.png");
    
    // Helper function that chains a series of promise-returning
    // functions together via their done callbacks.
    function chain() {
        var functions = Array.prototype.slice.call(arguments, 0);
        if (functions.length > 0) {
            var firstFunction = functions.shift();
            var firstPromise = firstFunction.call();
            firstPromise.done(function () {
                chain.apply(null, functions);
            });
        }
    }
    
    // Helper function to check if the github panel is open
    function _isPanelOpen() {
        return $issuesPanel.is(":visible");
    }
    
    // Handles toggling the panel
    function _togglePanel() {
        
        if (_isPanelOpen()) {
            $issuesPanel.hide();
        } else {
            $issuesPanel.show();
            _listIssues();
        }
        
        EditorManager.resizeEditor();
        
        CommandManager.get(CMD_GH_ISSUES_LIST).setChecked(_isPanelOpen());
    }
    
    // Starts the new issue workflow
    function _createIssue() {        
        var dialog = Dialogs.showModalDialogUsingTemplate(
            Mustache.render(IssueDialogNewTPL, ghRepoInfo)
        );
        
        var submitClass     = "gh-create",
            cancelClass     = "gh-cancel",
            $dialogBody     = dialog.getElement().find(".modal-body"),
            $title          = $dialogBody.find(".gh-issue-title").focus(),
            $message        = $dialogBody.find(".gh-issue-message");
        
        $dialogBody.delegate(".btn", "click", function(event) {
            var $btn = $(event.currentTarget);
            
            if ($btn.hasClass(cancelClass)) {
                dialog.close();
            } else if ($btn.hasClass(submitClass)) {
                $dialogBody.toggleClass("loading");

                gh.newIssue($title.val(), $message.val()).done(function(issue) {
                    if (issue && issue.html_url) {
                        dialog.close();
                        _viewIssue(issue);
                    } else {
                        $dialogBody.toggleClass("error loading");
                    }
                });
            }
        });        
    }
    
    // Open the detailed issue dialog
    function _viewIssue(issue) {
        
        issue.state_class = issue.state === "open" ? "success" : "error";
        issue.body = marked(issue.body);

        var dialog = Dialogs.showModalDialogUsingTemplate(
            Mustache.render(IssueDialogViewTPL, issue)
        );

        gh.getComments(issue.number).done(function(result) {
            var $dialogBody         = dialog.getElement(),
                $conversation       = $dialogBody.find(".issue-conversation"),
                $participants       = $dialogBody.find(".issue-participants"),
                $commentInputPanel  = $dialogBody.find(".issue-comment-input"),
                participantsList    = [],
                participantsMap     = {};
                        
            result.forEach(function(comment) {
                participantsMap[comment.user.login] = comment.user;
                
                comment.created_at = moment(comment.created_at).fromNow();
                comment.body = marked(comment.body);
                
                $conversation.append(Mustache.render(IssueCommentTPL, comment));
            });
            
            participantsMap[issue.user.login] = issue.user;
            
            participantsList = $.map(participantsMap, function(participant) {
                return participant.avatar_url;
            });
            
            $participants.append(Mustache.render(IssueParticipantsTPL, {participants: participantsList} ));

            $commentInputPanel.append(Mustache.render(IssueCommentInputTPL, {}));
            
            $commentInputPanel.find('a[data-action="preview"]').on('shown', function (e) {
                var $commentInput   = $commentInputPanel.find(".comment-body"),
                    $commentPreview = $commentInputPanel.find(".comment-preview");

                $commentPreview.html(marked($commentInput.val()));
            });
            
            dialog.getElement().find(".modal-body").removeClass("loading");
        }).fail(function(err) {
            console.log(err);
        });

        /*
        var dialog = Dialogs.showModalDialogUsingTemplate(Mustache.render(IssueDialogViewTPL, issue)),
            $dialogBody, $commentButton, $closeButton, $commentBody;
        
        console.log(issue);
        
        $dialogBody = dialog.getElement();
        $commentButton = $dialogBody.find(".btn-comment");
        $closeButton = $dialogBody.find(".btn-close");
        $commentBody = $dialogBody.find(".comment-body");
        
        $closeButton.on("click", function(event) {
            nodeConnection.domains.gh.closeIssue(issue.number);
        });
        
        $commentButton.on("click", function(event) {
            nodeConnection.domains.gh.commentIssue(issue.number, $commentBody.val());
        });
        */
    }
    
    // Retrieves the list of issues for the repo
    function _listIssues() {
        var state       = $issuesPanel.find(".issue-state.disabled").data("state"),
            assignee    = $issuesPanel.find(".issue-assignee.disabled").data("assignee") == "own";
        
        $issuesWrapper.addClass("loading");
        $issuesList.empty();

        gh.listIssues(state, assignee).done(function(data) {
            data.issues.forEach(function(issue) {

                issue.created_at = moment(issue.created_at).fromNow();
                
                var data = {
                    githubLogo: githubLogo,
                    issue: issue
                }

                var $row = $(Mustache.render(IssueTableRowTPL, data));
                
                $row.data("issue", issue);
                
                $issuesList.append($row);
                
                $issuesWrapper.removeClass("loading");
            });
        });
    }
    
    // Initializes and and binds the events on the Issues Panel
    function _initializeIssuesPanel() {
        var $content    = $(".content").append(Mustache.render(IssuePanelTPL, ghRepoInfo));
            
        $issuesPanel    = $content.find(".gh-issue-panel");
        $issuesWrapper  = $issuesPanel.find(".gh-issues-wrapper");
        $issuesList     = $issuesPanel.find(".gh-issues-list");
        
        $issuesList.delegate("tr.gh-issue", "click", function(event) {
           _viewIssue($(event.currentTarget).data("issue"));
        });
        
        $issuesWrapper.find(".close").on("click", _togglePanel);

        $issuesWrapper.delegate(".btn.issue-state", "click", function(event) {
            var $target = $(event.currentTarget);
            
            if (!$issuesWrapper.hasClass("loading") && !$target.hasClass("disabled")) {
                $issuesWrapper.find(".btn.issue-state").toggleClass("disabled");
                _listIssues();
            }
        });
        
        $issuesWrapper.delegate(".btn.issue-assignee", "click", function(event) {
            var $target = $(event.currentTarget);
            
            if (!$issuesWrapper.hasClass("loading") && !$target.hasClass("disabled")) {
                $issuesWrapper.find(".btn.issue-assignee").toggleClass("disabled");
                _listIssues();
            }
        });
    }
    
    //
    function _initializeUI() {
        // Load de CSS styles and initialize the HTML content
        ExtensionUtils.loadStyleSheet(module, "css/styles.css").done(function () {
            _initializeIssuesPanel();
        });
        
        ExtensionUtils.loadStyleSheet(module, "css/font-awesome.css").done(function () {
        });
    }
    
    // Initialize brackets-gh extension and node domain
    AppInit.appReady(function () {
        nodeConnection = new NodeConnection();
        
        // Helper function that tries to connect to node
        function connect() {
            var connectionPromise = nodeConnection.connect(true);
            
            connectionPromise.fail(function () {
                console.error("[brackets-gh] failed to connect to node");
            });
            
            return connectionPromise;
        }
        
        // Helper function that loads our domain into the node server
        function loadGHDomain() {
            var path        = ExtensionUtils.getModulePath(module, "node/GHDomain"),
                projectPath = ProjectManager.getProjectRoot().fullPath,
                loadPromise = nodeConnection.loadDomains([path], true);

            loadPromise.then(function(){
                gh = nodeConnection.domains.gh;
                gh.setPath(projectPath).done(function(repoInfo) {
                    ghRepoInfo = repoInfo;
                    _initializeUI();
                });
            }).fail(function (error) {
                console.log("[brackets-gh] failed to load gh domain");
                console.log(error);
            });

            return loadPromise;
        }

        chain(connect, loadGHDomain);
        
        $(ProjectManager).on("projectOpen", function (event, projectRoot) {
            nodeConnection.domains.gh.setPath(projectRoot.fullPath);
        });
        
        CommandManager.register("Github Issues", CMD_GH_ISSUES_LIST, _togglePanel);
        CommandManager.register("New Issue", CMD_GH_ISSUES_NEW, _createIssue);
        
        // Register command
        var menu = Menus.getMenu(Menus.AppMenuBar.VIEW_MENU);
        menu.addMenuDivider();
        menu.addMenuItem(CMD_GH_ISSUES_LIST, "", Menus.LAST);
        menu.addMenuItem(CMD_GH_ISSUES_NEW, "", Menus.LAST);
    });
});