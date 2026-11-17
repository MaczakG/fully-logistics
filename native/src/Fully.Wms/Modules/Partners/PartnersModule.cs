using System.Runtime.CompilerServices;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Partners;

// Partnerek: clients, carriers and suppliers. A partner in its own window with its tabs; the small
// edits (contact, contract, document, custom item, webshop connection, API key) in dialogs.
static class PartnersModule
{
    [ModuleInitializer]
    internal static void Register()
    {
        AppModules.Use("partners", (s) => new PartnersViewModel(s));
        PageLocator.Register<PartnersViewModel>(() => new PartnersView());
        PageLocator.Register<PartnerViewModel>(() => new PartnerView());
        PageLocator.Register<PartnerNewViewModel>(() => new PartnerNewView());
        PageLocator.Register<ContactFormViewModel>(() => new ContactFormView());
        PageLocator.Register<ContractFormViewModel>(() => new ContractFormView());
        PageLocator.Register<DocumentUploadViewModel>(() => new DocumentUploadView());
        PageLocator.Register<DocumentEditViewModel>(() => new DocumentEditView());
        PageLocator.Register<CustomItemFormViewModel>(() => new CustomItemFormView());
        PageLocator.Register<ConnectionFormViewModel>(() => new ConnectionFormView());
        PageLocator.Register<ApiKeyFormViewModel>(() => new ApiKeyFormView());
        PageLocator.Register<ApiKeyShownViewModel>(() => new ApiKeyShownView());
    }
}
